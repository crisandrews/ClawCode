#!/usr/bin/env bash
# reconcile-crons.sh — SessionStart hook for ClawCode.
# Injects identity, seeds cron registry, cleans up legacy marker, and emits a
# deterministic reconcile envelope for the agent to execute (CronList →
# CronCreate missing → adopt unknown → report).
#
# Failure-mode contract: NEVER blocks session start. Any error path exits 0
# with a warning on stderr. See docs/crons.md.
set -uo pipefail

AGENT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$HOOK_DIR")}"
WRITEBACK="$PLUGIN_ROOT/skills/crons/writeback.sh"

MEMORY_DIR="$AGENT_ROOT/memory"
REGISTRY="$MEMORY_DIR/crons.json"
LEGACY_MARKER="$AGENT_ROOT/.crons-created"
RECONCILING_MARKER="$MEMORY_DIR/.reconciling"
OPENCLAW_CRON="${CLAWCODE_OPENCLAW_CRON:-$HOME/.openclaw/cron/jobs.json}"
IMPORT_BACKLOG="$AGENT_ROOT/IMPORT_BACKLOG.md"

fallback_warn() {
  echo "[clawcode] Reconcile hook failed (${1:-unknown}). Run /agent:crons reconcile manually once the REPL is up." >&2
  exit 0
}

# --- 1. BOOTSTRAP path (first run, no identity files yet) ---
if [[ -f "$AGENT_ROOT/BOOTSTRAP.md" ]]; then
  echo '[clawcode] BOOTSTRAP.md detected — this is a first run. Follow the BOOTSTRAP.md instructions to discover your identity.'
  exit 0
fi

# --- 2. IDENTITY INJECTION (preserve existing behavior) ---
echo '=== YOUR IDENTITY (you MUST embody this) ==='
cat "$AGENT_ROOT/SOUL.md" 2>/dev/null || true
echo ''
cat "$AGENT_ROOT/IDENTITY.md" 2>/dev/null || true
echo ''
echo '=== USER CONTEXT ==='
cat "$AGENT_ROOT/USER.md" 2>/dev/null || true
echo ''

# --- 3. JQ PRESENCE CHECK (degraded mode if jq absent) ---
if ! command -v jq >/dev/null 2>&1; then
  echo '[clawcode] WARNING: jq not installed. Cron persistence runs in degraded defaults-only mode.' >&2
  echo 'Install jq (macOS: brew install jq | Linux: apt install jq) for full registry behavior.' >&2
  cat <<'DEGRADED'

=== CLAWCODE RECONCILE (degraded — jq missing) ===
STEP 1: ToolSearch with query "select:CronList,CronCreate,CronDelete".
STEP 2: Call CronList. Scan output for the heartbeat and dreaming cron expressions.
STEP 3: If heartbeat is not present, call CronCreate with cron "*/30 * * * *", prompt "Run /agent:heartbeat", durable true, recurring true.
STEP 4: If dreaming is not present, call CronCreate with cron "0 3 * * *", prompt "Use the dream tool: dream(action=run)", durable true, recurring true.
STEP 5: Print "[clawcode] Reconcile done (degraded)".
DEGRADED
  exit 0
fi

# --- 4. SEED DEFAULTS / VALIDATE REGISTRY ---
# seed-defaults is idempotent when valid; when corrupt, writeback.sh quarantines
# to crons.json.corrupt-<ts> and rebuilds from defaults. Run unconditionally so
# every SessionStart guarantees a valid registry on exit.
if ! bash "$WRITEBACK" seed-defaults 2>&1; then
  fallback_warn "seed-defaults returned non-zero"
fi

# --- 5. LEGACY MARKER CLEANUP (after we know registry exists) ---
if [[ -f "$REGISTRY" && -f "$LEGACY_MARKER" ]]; then
  rm -f "$LEGACY_MARKER" 2>/dev/null || true
fi

# --- 6. DETECT MIGRATION (progressive enhancement — silent unless evidence) ---
MIGRATION_NEEDED=0
MIGRATION_AGENT=""
if [[ -f "$IMPORT_BACKLOG" && -f "$OPENCLAW_CRON" ]]; then
  MIGRATION_ANSWERED=$(jq -r '.migration.openclawAnsweredAt // "null"' "$REGISTRY" 2>/dev/null || echo "null")
  if [[ "$MIGRATION_ANSWERED" == "null" ]]; then
    MIGRATION_AGENT=$(grep -m1 "^Agent:" "$IMPORT_BACKLOG" 2>/dev/null | sed 's/^Agent:[[:space:]]*//' || true)
    if [[ -n "$MIGRATION_AGENT" && -s "$OPENCLAW_CRON" ]]; then
      MIGRATION_NEEDED=1
    fi
  fi
fi

# --- 7. BUILD EXPECTED SET ---
EXPECTED_LINES=""
if [[ -f "$REGISTRY" ]]; then
  EXPECTED_LINES=$(jq -r '
    .entries[]
    | select(.paused == false and .tombstone == null)
    | "- key=\(.key) cron=\"\(.cron)\" prompt=\"\(.prompt)\" recurring=\(.recurring)"
  ' "$REGISTRY" 2>/dev/null || true)
fi

if [[ -z "$EXPECTED_LINES" ]]; then
  echo '[clawcode] Cron registry has no expected entries. Nothing to reconcile.' >&2
  exit 0
fi

EXPECTED_COUNT=$(printf '%s\n' "$EXPECTED_LINES" | wc -l | tr -d ' ')

# --- 8. PLAN_ID (informational, for log traceability) ---
PLAN_ID=""
if command -v shasum >/dev/null 2>&1; then
  PLAN_ID=$(date +%s | shasum | cut -c1-8)
elif command -v sha256sum >/dev/null 2>&1; then
  PLAN_ID=$(date +%s | sha256sum | cut -c1-8)
else
  PLAN_ID=$(date +%s)
fi

# --- 9. CREATE RECURSION MARKER (cron-posttool.sh reads this to skip capture) ---
mkdir -p "$MEMORY_DIR"
touch "$RECONCILING_MARKER" 2>/dev/null || true

# --- 10. BUILD ENVELOPE IN VARIABLE (read -d '' avoids $()-paren-matching bug) ---
# Note: steps use "first/second/third" instead of a)/b)/c) to avoid paren
# parsing inside $() wrapping. Envelope is written to a single variable so
# emission is atomic (either the whole thing or nothing). See plan §Delta #10.
ENVELOPE=""
IFS='' read -r -d '' ENVELOPE <<ENV || true

=== CLAWCODE RECONCILE ===
PLAN_ID: $PLAN_ID

The cron registry at memory/crons.json is the source of truth. A marker at memory/.reconciling is active to suppress PostToolUse capture during this reconcile. Execute the following steps in order.

STEP 1: Call ToolSearch with query "select:CronList,CronCreate,CronDelete".
STEP 2: Call CronList. Output is plain text — one line per alive job in the format:
        <8hex-id> — <cron-expr> (recurring|one-shot) [session-only|durable]: <prompt>
        Empty state is the literal string "No scheduled jobs.".
STEP 3: For each EXPECTED entry listed below whose key's current harnessTaskId is NOT among the 8-hex task IDs in CronList output:
        - Call CronCreate with that entry's cron, prompt, durable=true, recurring.
        - Capture the 8-hex task_id from the "Scheduled ... job <id>" response.
        - Run: bash $WRITEBACK set-alive --key <entry's key> --harness-task-id <new task_id>
STEP 4: Pipe the full CronList output to: bash $WRITEBACK adopt-unknown
        It skips task IDs already registered and adopts the rest as source=ad-hoc.
STEP 5: Print one line: [clawcode] Reconcile $PLAN_ID done: recreated=<N> adopted=<M> alive=<K>
STEP 6: Remove the recursion marker: rm -f "$RECONCILING_MARKER"

EXPECTED ($EXPECTED_COUNT entries):
$EXPECTED_LINES
ENV

# --- 11. MIGRATION OFFER (conditional, appended to same envelope) ---
if [[ $MIGRATION_NEEDED -eq 1 ]]; then
  MIGRATION_BLOCK=""
  IFS='' read -r -d '' MIGRATION_BLOCK <<MIG || true

STEP 7 (MIGRATION OFFER — IMPORT_BACKLOG.md and OpenClaw source both present; migration not yet answered):
After STEPS 1-6 complete, call AskUserQuestion with:
  question: "Detecté que este workspace tenía crons del agente $MIGRATION_AGENT que se perdieron por un bug en versiones anteriores. ¿Los re-importo ahora?"
  header: "Migración"
  options:
    - label: "Sí, re-importar ahora"
      description: "Corre /agent:crons import con la fuente original (~/.openclaw/cron/jobs.json). Los reminders quedan registrados para sobrevivir cierres de sesión."
    - label: "Después"
      description: "No preguntar ahora. Podés correr /agent:crons manualmente cuando quieras."
    - label: "No, nunca"
      description: "Marca el workspace como 'no migrar'. No se vuelve a preguntar."

Based on the user's answer:
  "Sí, re-importar ahora" → run /agent:crons import, then: bash $WRITEBACK migration-mark --value imported
  "Después" → do nothing (hook will re-offer next session).
  "No, nunca" → bash $WRITEBACK migration-mark --value declined
MIG
  ENVELOPE="$ENVELOPE$MIGRATION_BLOCK"
fi

# --- 12. EMIT ENVELOPE ATOMICALLY ---
if [[ -n "$ENVELOPE" ]]; then
  printf '%s\n' "$ENVELOPE"
else
  fallback_warn "envelope build produced empty string"
fi

exit 0
