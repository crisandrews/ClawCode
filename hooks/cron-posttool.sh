#!/usr/bin/env bash
# cron-posttool.sh — PostToolUse hook for CronCreate and CronDelete.
# Captures ad-hoc cron creations into the registry automatically; tombstones
# user-initiated deletes. Runs in strict guard mode:
#
#   - Recursion guard: skip if memory/.reconciling marker is fresh (<10 min).
#   - Idempotency: skip if harnessTaskId already tracked.
#   - Non-blocking: any failure exits 0 silently.
#
# See docs/crons.md for the full rationale.
set -uo pipefail

# See reconcile-crons.sh for the full rationale. Same PATH prefix so jq
# installed to ~/.local/bin is visible to this hook too.
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

AGENT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"
WRITEBACK="$PLUGIN_ROOT/skills/crons/writeback.sh"

MEMORY_DIR="$AGENT_ROOT/memory"
REGISTRY="$MEMORY_DIR/crons.json"
RECONCILING_MARKER="$MEMORY_DIR/.reconciling"
PENDING_LOG="$MEMORY_DIR/crons-pending.jsonl"
MAX_MARKER_AGE_SEC=600  # 10 minutes — stale marker is ignored

# Silent exit on any unexpected condition — hooks must never block.
command -v jq >/dev/null 2>&1 || exit 0

PAYLOAD=$(cat 2>/dev/null || true)
[[ -z "$PAYLOAD" ]] && exit 0

TOOL_NAME=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null || true)
case "$TOOL_NAME" in
  CronCreate|CronDelete) ;;
  *) exit 0 ;;
esac

# --- Recursion guard: suppress capture during SessionStart reconcile. ---
if [[ -f "$RECONCILING_MARKER" ]]; then
  marker_mtime=$(stat -f %m "$RECONCILING_MARKER" 2>/dev/null || stat -c %Y "$RECONCILING_MARKER" 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$((now - marker_mtime))
  if [[ $age -ge 0 && $age -lt $MAX_MARKER_AGE_SEC ]]; then
    exit 0
  fi
  # Stale: clean up and fall through.
  rm -f "$RECONCILING_MARKER" 2>/dev/null || true
fi

# --- Dispatch ---
if [[ "$TOOL_NAME" == "CronCreate" ]]; then
  CRON=$(printf '%s' "$PAYLOAD"       | jq -r '.tool_input.cron // empty'      2>/dev/null || true)
  PROMPT=$(printf '%s' "$PAYLOAD"     | jq -r '.tool_input.prompt // empty'    2>/dev/null || true)
  # NOT `.tool_input.recurring // true`: jq's `//` swallows boolean false, so
  # that idiom stored every one-shot as recurring=true — which made fired
  # one-shots invisible to writeback.sh prune-expired (it requires
  # recurring==false) and resurrected them on every reconcile.
  RECURRING=$(printf '%s' "$PAYLOAD"  | jq -r 'if (.tool_input | has("recurring")) then (.tool_input.recurring | tostring) else "true" end' 2>/dev/null || echo "true")

  [[ -z "$CRON" || -z "$PROMPT" ]] && exit 0

  # Extract 8hex task_id. The harness response shape changed across versions:
  #   v2.1.114+: tool_response is an object: {"id":"abc12345","humanSchedule":...,"durable":false}
  #   v2.1.113-: tool_response is a string: "Scheduled <id> (<cron>)" or
  #              "Scheduled recurring|one-shot job <id> ..."
  # Try object form first (modern), fall back to string regex (legacy).
  TASK_ID=$(printf '%s' "$PAYLOAD" | jq -r '.tool_response.id // empty' 2>/dev/null || true)
  if [[ -z "$TASK_ID" ]]; then
    RESPONSE=$(printf '%s' "$PAYLOAD" | jq -r '.tool_response // empty' 2>/dev/null || true)
    if [[ "$RESPONSE" =~ Scheduled[[:space:]]+((recurring|one-shot)[[:space:]]+job[[:space:]]+)?([0-9a-f]{8}) ]]; then
      TASK_ID="${BASH_REMATCH[3]}"
    fi
  fi
  [[ -z "$TASK_ID" ]] && exit 0  # No task_id found → tool may have failed; do nothing.

  # Idempotency check: skip if harnessTaskId already tracked under any key.
  if [[ -f "$REGISTRY" ]]; then
    if jq -e --arg id "$TASK_ID" '.entries | any(.harnessTaskId == $id)' "$REGISTRY" >/dev/null 2>&1; then
      exit 0
    fi
  fi

  # Audit trail.
  mkdir -p "$MEMORY_DIR" 2>/dev/null || true
  printf '{"ts":"%s","tool":"CronCreate","task_id":"%s","cron":%s,"prompt":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TASK_ID" \
    "$(printf '%s' "$CRON"   | jq -Rs .)" \
    "$(printf '%s' "$PROMPT" | jq -Rs .)" \
    >> "$PENDING_LOG" 2>/dev/null || true

  # Explicit expiry metadata: bin/cron-from.sh stamps line 3 of
  # memory/.cron-last-stamp with the one-shot's target epoch (empty for
  # recurring). Trust it only when the stamp's cron matches the captured
  # cron — the same binding rule the pretool gate enforces. This is what
  # lets writeback.sh prune-expired retire fired one-shots instead of
  # reconcile resurrecting them a year later.
  TARGET_EPOCH=""
  STAMP_FILE="$MEMORY_DIR/.cron-last-stamp"
  if [[ -f "$STAMP_FILE" ]]; then
    STAMP_CRON=$(sed -n 1p "$STAMP_FILE" 2>/dev/null || true)
    STAMP_TARGET=$(sed -n 3p "$STAMP_FILE" 2>/dev/null || true)
    if [[ "$STAMP_CRON" == "$CRON" && "$STAMP_TARGET" =~ ^[0-9]+$ ]]; then
      TARGET_EPOCH="$STAMP_TARGET"
    fi
  fi

  # Two explicit invocations instead of a ${VAR:+...} conditional expansion:
  # bash word-splits that correctly (two argv words) but zsh would pass a
  # single "--target-epoch <n>" word — this hook is bash, but the explicit
  # form costs nothing and can't be mis-run or mis-read.
  if [[ -n "$TARGET_EPOCH" ]]; then
    bash "$WRITEBACK" upsert \
      --harness-task-id "$TASK_ID" \
      --source ad-hoc \
      --cron "$CRON" \
      --prompt "$PROMPT" \
      --recurring "$RECURRING" \
      --target-epoch "$TARGET_EPOCH" >/dev/null 2>&1 || exit 0
  else
    bash "$WRITEBACK" upsert \
      --harness-task-id "$TASK_ID" \
      --source ad-hoc \
      --cron "$CRON" \
      --prompt "$PROMPT" \
      --recurring "$RECURRING" >/dev/null 2>&1 || exit 0
  fi

elif [[ "$TOOL_NAME" == "CronDelete" ]]; then
  TASK_ID=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.id // empty' 2>/dev/null || true)
  [[ -z "$TASK_ID" ]] && exit 0

  # Tombstone only on successful delete. Same response-shape evolution as
  # CronCreate: modern is object {"cancelled":true,...}, legacy is text
  # containing the word "Cancelled". Accept either as success signal.
  CANCELLED_FLAG=$(printf '%s' "$PAYLOAD" | jq -r '.tool_response.cancelled // false' 2>/dev/null || echo "false")
  if [[ "$CANCELLED_FLAG" != "true" ]]; then
    RESPONSE=$(printf '%s' "$PAYLOAD" | jq -r '.tool_response // empty' 2>/dev/null || true)
    case "$RESPONSE" in
      *Cancelled*) ;;
      *) exit 0 ;;
    esac
  fi

  bash "$WRITEBACK" tombstone --harness-task-id "$TASK_ID" >/dev/null 2>&1 || exit 0
fi

exit 0
