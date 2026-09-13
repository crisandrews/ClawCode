#!/usr/bin/env bash
# cron-pretool.sh — PreToolUse hook for CronCreate.
# Blocks the tool call unless the cron expression matches a recent
# bin/cron-from.sh output, turning skill rule #1 (never compute cron
# expressions yourself) from doctrine into an enforced invariant.
#
#   - Reads memory/.cron-last-stamp (three lines: cron, epoch seconds,
#     target epoch for one-shots; this gate consumes the first two).
#   - Accepts if stamp age < 120s AND stamp cron == tool_input.cron.
#   - Exits 0 silently for unrelated tools, empty payloads, or when
#     memory/.reconciling marker is fresh (<10 min since its last
#     refresh — writeback.sh set-alive refreshes it as the reconcile
#     progresses) — SessionStart reconcile recreates crons from the
#     registry and must bypass this check, same pattern as
#     hooks/cron-posttool.sh.
#   - On rejection: exit 2 with a stderr message that teaches the
#     agent the fix (run cron-from.sh first).
#
# See docs/crons.md for the full rationale.
set -uo pipefail

# Same PATH prefix as the other crons hooks so jq installed to
# ~/.local/bin is visible under a stripped launchd/systemd PATH.
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

AGENT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
MEMORY_DIR="$AGENT_ROOT/memory"
STAMP="$MEMORY_DIR/.cron-last-stamp"
RECONCILING_MARKER="$MEMORY_DIR/.reconciling"
MAX_STAMP_AGE_SEC=120
MAX_RECONCILE_AGE_SEC=600

# Silent exit on any unexpected condition — hooks must not block unrelated
# work. If jq is missing we let the call through (posttool has the same
# fallback; the user is already degraded in visible ways elsewhere).
command -v jq >/dev/null 2>&1 || exit 0

PAYLOAD=$(cat 2>/dev/null || true)
[[ -z "$PAYLOAD" ]] && exit 0

TOOL_NAME=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)
[[ "$TOOL_NAME" == "CronCreate" ]] || exit 0

# Reconcile bypass: SessionStart touches the marker before replaying the
# registry's crons through CronCreate. Those calls re-use stored crons
# and must not be gated.
if [[ -f "$RECONCILING_MARKER" ]]; then
  marker_mtime=$(stat -c %Y "$RECONCILING_MARKER" 2>/dev/null || stat -f %m "$RECONCILING_MARKER" 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$((now - marker_mtime))
  if [[ $age -ge 0 && $age -lt $MAX_RECONCILE_AGE_SEC ]]; then
    exit 0
  fi
  rm -f "$RECONCILING_MARKER" 2>/dev/null || true
fi

INPUT_CRON=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.cron // empty' 2>/dev/null)
# No cron in the input → let the harness handle the validation error
# (not our job to double-check schemas).
[[ -z "$INPUT_CRON" ]] && exit 0

# Appended to every rejection: a long reconcile interleaved with chat can
# outlive the .reconciling marker (it expires 10 min after its last refresh;
# writeback.sh set-alive refreshes it on every recreated entry). Without
# this hint the agent gets a stamp error that points at cron-from.sh, which
# is the wrong fix mid-reconcile (registry crons are replayed verbatim).
RECONCILE_HINT="If you are mid-reconcile (recreating registry entries from memory/crons.json after SessionStart), the memory/.reconciling marker has expired — run:  touch \"$MEMORY_DIR/.reconciling\"  and retry. It auto-expires 10 minutes after its last refresh."

if [[ ! -f "$STAMP" ]]; then
  >&2 cat <<EOF
❌ CronCreate blocked: no cron-from.sh stamp found.
Skill rule #1 (skills/crons/SKILL.md) requires every cron expression to
come from the deterministic helper. Run it first, then re-issue CronCreate
with its .cron field verbatim:

  bash \$CLAUDE_PLUGIN_ROOT/bin/cron-from.sh relative 5 minutes
  bash \$CLAUDE_PLUGIN_ROOT/bin/cron-from.sh absolute "14:30"
  bash \$CLAUDE_PLUGIN_ROOT/bin/cron-from.sh recurring daily "09:00"
  bash \$CLAUDE_PLUGIN_ROOT/bin/cron-from.sh passthrough "0 0 * * 0-3"
EOF
  >&2 printf '\n%s\n' "$RECONCILE_HINT"
  exit 2
fi

STAMP_CRON=$(sed -n 1p "$STAMP" 2>/dev/null || true)
STAMP_TS=$(sed -n 2p "$STAMP" 2>/dev/null || true)

# Defensive: if the stamp file is malformed, treat as missing rather than
# silently passing. Same guidance as the missing-stamp case.
if [[ -z "$STAMP_CRON" || -z "$STAMP_TS" || ! "$STAMP_TS" =~ ^[0-9]+$ ]]; then
  >&2 echo "❌ CronCreate blocked: cron-from.sh stamp at '$STAMP' is malformed. Re-run the helper immediately before CronCreate."
  >&2 printf '\n%s\n' "$RECONCILE_HINT"
  exit 2
fi

NOW=$(date +%s)
AGE=$((NOW - STAMP_TS))

if (( AGE < 0 )); then
  # Clock went backwards — treat as fresh (avoid blocking legit work on
  # NTP corrections). No block.
  AGE=0
fi

if (( AGE >= MAX_STAMP_AGE_SEC )); then
  >&2 echo "❌ CronCreate blocked: cron-from.sh stamp is ${AGE}s old (max ${MAX_STAMP_AGE_SEC}s). Re-run the helper immediately before CronCreate so the cron reflects current time."
  >&2 printf '\n%s\n' "$RECONCILE_HINT"
  exit 2
fi

if [[ "$INPUT_CRON" != "$STAMP_CRON" ]]; then
  >&2 cat <<EOF
❌ CronCreate blocked: cron expression does not match the last cron-from.sh output.
  your CronCreate.cron : $INPUT_CRON
  last helper output   : $STAMP_CRON
Use the helper's .cron field verbatim, or run the helper again (e.g.
'passthrough "<cron>"') to register the expression you actually want.
EOF
  >&2 printf '\n%s\n' "$RECONCILE_HINT"
  exit 2
fi

exit 0
