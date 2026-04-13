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
  RECURRING=$(printf '%s' "$PAYLOAD"  | jq -r '.tool_input.recurring // true'  2>/dev/null || echo "true")
  RESPONSE=$(printf '%s' "$PAYLOAD"   | jq -r '.tool_response // empty'        2>/dev/null || true)

  [[ -z "$CRON" || -z "$PROMPT" || -z "$RESPONSE" ]] && exit 0

  # Extract 8hex task_id from the CronCreate response text.
  if [[ "$RESPONSE" =~ Scheduled\ (recurring|one-shot)\ job\ ([0-9a-f]{8}) ]]; then
    TASK_ID="${BASH_REMATCH[2]}"
  else
    exit 0  # No task_id found → tool may have failed; do nothing.
  fi

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

  bash "$WRITEBACK" upsert \
    --harness-task-id "$TASK_ID" \
    --source ad-hoc \
    --cron "$CRON" \
    --prompt "$PROMPT" \
    --recurring "$RECURRING" >/dev/null 2>&1 || exit 0

elif [[ "$TOOL_NAME" == "CronDelete" ]]; then
  TASK_ID=$(printf '%s' "$PAYLOAD"  | jq -r '.tool_input.id // empty' 2>/dev/null || true)
  RESPONSE=$(printf '%s' "$PAYLOAD" | jq -r '.tool_response // empty' 2>/dev/null || true)

  [[ -z "$TASK_ID" ]] && exit 0

  # Tombstone only on successful delete.
  case "$RESPONSE" in
    *Cancelled*) ;;
    *) exit 0 ;;
  esac

  bash "$WRITEBACK" tombstone --harness-task-id "$TASK_ID" >/dev/null 2>&1 || exit 0
fi

exit 0
