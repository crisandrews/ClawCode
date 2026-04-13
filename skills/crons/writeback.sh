#!/usr/bin/env bash
# writeback.sh — sole writer for memory/crons.json
# Called by hooks/reconcile-crons.sh, hooks/cron-posttool.sh, and skills/crons/SKILL.md.
# See docs/crons.md for the registry schema and the full lifecycle.
set -uo pipefail

AGENT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
MEMORY_DIR="$AGENT_ROOT/memory"
REGISTRY="$MEMORY_DIR/crons.json"
LOCK_DIR="$MEMORY_DIR/.crons-lock"
ERRORS_LOG="$MEMORY_DIR/crons-errors.jsonl"
SUBCMD="${1:-}"
shift || true

iso_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

ensure_memory_dir() {
  mkdir -p "$MEMORY_DIR"
}

ensure_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "writeback.sh: jq is required but not installed" >&2
    exit 3
  fi
}

acquire_lock() {
  ensure_memory_dir
  local retries=3
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    retries=$((retries - 1))
    if [[ $retries -le 0 ]]; then
      echo "writeback.sh: failed to acquire lock after 3 retries" >&2
      exit 2
    fi
    sleep 0.5
  done
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
}

log_error() {
  mkdir -p "$MEMORY_DIR" 2>/dev/null || true
  printf '{"ts":"%s","subcommand":"%s","error":%s}\n' \
    "$(iso_now)" "$SUBCMD" "$(jq -Rn --arg e "$1" '$e')" >> "$ERRORS_LOG" 2>/dev/null || true
}

write_atomic() {
  local tmp="$REGISTRY.tmp.$$"
  cat > "$tmp"
  mv "$tmp" "$REGISTRY"
}

_write_fresh_registry() {
  # Caller must hold lock.
  local now
  now=$(iso_now)
  cat > "$REGISTRY" <<EOF
{
  "version": 1,
  "updatedAt": "$now",
  "migration": { "openclawOffered": false, "openclawAnsweredAt": null },
  "entries": [
    {
      "key": "heartbeat-default",
      "cron": "*/30 * * * *",
      "prompt": "Run /agent:heartbeat",
      "recurring": true,
      "source": "default-heartbeat",
      "note": "Default 30-min heartbeat",
      "createdAt": "$now",
      "lastSeenAlive": null,
      "harnessTaskId": null,
      "paused": false,
      "tombstone": null,
      "adoptedAt": null
    },
    {
      "key": "dreaming-default",
      "cron": "0 3 * * *",
      "prompt": "Use the dream tool: dream(action=run)",
      "recurring": true,
      "source": "default-dreaming",
      "note": "Default 3am dreaming",
      "createdAt": "$now",
      "lastSeenAlive": null,
      "harnessTaskId": null,
      "paused": false,
      "tombstone": null,
      "adoptedAt": null
    }
  ]
}
EOF
}

_ensure_registry() {
  # Caller must hold lock. Quarantines invalid files, bootstraps fresh if needed.
  if [[ -f "$REGISTRY" ]]; then
    if ! jq -e '.version == 1 and has("entries")' "$REGISTRY" >/dev/null 2>&1; then
      local corrupt_path="$REGISTRY.corrupt-$(date +%s)"
      mv "$REGISTRY" "$corrupt_path"
      echo "writeback.sh: registry corrupt, quarantined to $corrupt_path; rebuilding from defaults" >&2
      _write_fresh_registry
    fi
  else
    _write_fresh_registry
  fi
}

_add_default_if_missing() {
  # Caller must hold lock and have a valid registry.
  local key="$1" cron="$2" prompt="$3" source="$4" note="$5"
  local now
  now=$(iso_now)
  jq --arg key "$key" --arg cron "$cron" --arg prompt "$prompt" \
     --arg source "$source" --arg note "$note" --arg now "$now" '
    if (.entries | any(.key == $key)) then .
    else .entries += [{
      key: $key,
      cron: $cron,
      prompt: $prompt,
      recurring: true,
      source: $source,
      note: $note,
      createdAt: $now,
      lastSeenAlive: null,
      harnessTaskId: null,
      paused: false,
      tombstone: null,
      adoptedAt: null
    }] end |
    .updatedAt = $now
  ' "$REGISTRY" | write_atomic
}

# ------------------- subcommands -------------------

cmd_seed_defaults() {
  acquire_lock
  _ensure_registry
  _add_default_if_missing "heartbeat-default" "*/30 * * * *" "Run /agent:heartbeat" "default-heartbeat" "Default 30-min heartbeat"
  _add_default_if_missing "dreaming-default" "0 3 * * *" "Use the dream tool: dream(action=run)" "default-dreaming" "Default 3am dreaming"
}

cmd_upsert() {
  local key="" harness_id="" source="" cron="" prompt="" recurring="true" note=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --key) key="$2"; shift 2;;
      --harness-task-id) harness_id="$2"; shift 2;;
      --source) source="$2"; shift 2;;
      --cron) cron="$2"; shift 2;;
      --prompt) prompt="$2"; shift 2;;
      --recurring) recurring="$2"; shift 2;;
      --note) note="$2"; shift 2;;
      *) echo "writeback.sh upsert: unknown flag $1" >&2; exit 2;;
    esac
  done

  [[ -z "$cron" ]] && { echo "upsert: --cron required" >&2; exit 2; }
  [[ -z "$prompt" ]] && { echo "upsert: --prompt required" >&2; exit 2; }
  [[ -z "$source" ]] && { echo "upsert: --source required" >&2; exit 2; }

  if [[ -z "$key" ]]; then
    [[ -z "$harness_id" ]] && { echo "upsert: either --key or --harness-task-id required" >&2; exit 2; }
    key="harness-$harness_id"
  fi

  acquire_lock
  _ensure_registry

  local now
  now=$(iso_now)

  jq --arg key "$key" --arg src "$source" --arg cron "$cron" --arg prompt "$prompt" \
     --arg recurring "$recurring" --arg note "$note" --arg harness "$harness_id" \
     --arg now "$now" '
    ((.entries | any(.key == $key)) as $exists |
    (if $exists then
      .entries |= map(
        if .key == $key then
          .harnessTaskId = (if $harness == "" then .harnessTaskId else $harness end) |
          .cron = $cron |
          .prompt = $prompt |
          .recurring = ($recurring == "true") |
          .source = $src |
          .note = (if $note == "" then .note else $note end) |
          .lastSeenAlive = $now |
          (if .tombstone != null then
             .tombstone = null | .createdAt = $now
           else . end)
        else . end
      )
    else
      .entries += [{
        key: $key,
        cron: $cron,
        prompt: $prompt,
        recurring: ($recurring == "true"),
        source: $src,
        note: $note,
        createdAt: $now,
        lastSeenAlive: $now,
        harnessTaskId: (if $harness == "" then null else $harness end),
        paused: false,
        tombstone: null,
        adoptedAt: null
      }]
    end)) |
    (if $src == "openclaw-import" and (.migration.openclawAnsweredAt == null) then
      .migration.openclawAnsweredAt = "auto-imported" | .migration.openclawOffered = true
    else . end) |
    .updatedAt = $now
  ' "$REGISTRY" | write_atomic
}

cmd_tombstone() {
  local key="" harness_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --key) key="$2"; shift 2;;
      --harness-task-id) harness_id="$2"; shift 2;;
      *) echo "tombstone: unknown flag $1" >&2; exit 2;;
    esac
  done

  if [[ -z "$key" && -z "$harness_id" ]]; then
    echo "tombstone: --key or --harness-task-id required" >&2; exit 2
  fi

  acquire_lock
  [[ -f "$REGISTRY" ]] || return 0  # nothing to tombstone

  local now
  now=$(iso_now)
  jq --arg key "$key" --arg harness "$harness_id" --arg now "$now" '
    .entries |= map(
      if ($key != "" and .key == $key) or ($harness != "" and .harnessTaskId == $harness) then
        .tombstone = $now
      else . end
    ) |
    .updatedAt = $now
  ' "$REGISTRY" | write_atomic
}

cmd_set_alive() {
  local key="" harness_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --key) key="$2"; shift 2;;
      --harness-task-id) harness_id="$2"; shift 2;;
      *) echo "set-alive: unknown flag $1" >&2; exit 2;;
    esac
  done

  [[ -z "$key" ]] && { echo "set-alive: --key required" >&2; exit 2; }
  [[ -z "$harness_id" ]] && { echo "set-alive: --harness-task-id required" >&2; exit 2; }

  acquire_lock
  [[ -f "$REGISTRY" ]] || { echo "set-alive: no registry found" >&2; exit 1; }

  if ! jq -e --arg key "$key" '.entries | any(.key == $key)' "$REGISTRY" >/dev/null; then
    echo "set-alive: key '$key' not found in registry" >&2
    exit 1
  fi

  local now
  now=$(iso_now)
  jq --arg key "$key" --arg harness "$harness_id" --arg now "$now" '
    .entries |= map(
      if .key == $key then
        .harnessTaskId = $harness | .lastSeenAlive = $now
      else . end
    ) |
    .updatedAt = $now
  ' "$REGISTRY" | write_atomic
}

cmd_adopt_unknown() {
  # Reads CronList output from stdin. For each alive task_id not in registry,
  # inserts an entry as source=ad-hoc, adoptedAt=<now>.
  acquire_lock
  _ensure_registry

  local input
  input=$(cat)

  if [[ "$input" == "No scheduled jobs." || -z "$input" ]]; then
    return 0
  fi

  local now
  now=$(iso_now)
  local line_count=0
  local matched_count=0

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    line_count=$((line_count + 1))

    # Expected: <8hex> — <cron> (recurring|one-shot) [session-only|durable]: <prompt>
    if [[ "$line" =~ ^([0-9a-f]{8})\ —\ (.+)\ \((recurring|one-shot)\)\ \[(session-only|durable)\]:\ (.+)$ ]]; then
      matched_count=$((matched_count + 1))
      local task_id="${BASH_REMATCH[1]}"
      local cron_expr="${BASH_REMATCH[2]}"
      local kind="${BASH_REMATCH[3]}"
      local cron_prompt="${BASH_REMATCH[5]}"
      local recurring_bool
      [[ "$kind" == "recurring" ]] && recurring_bool="true" || recurring_bool="false"

      if jq -e --arg id "$task_id" '.entries | any(.harnessTaskId == $id)' "$REGISTRY" >/dev/null; then
        continue
      fi

      local key="harness-$task_id"
      jq --arg key "$key" --arg id "$task_id" --arg cron "$cron_expr" \
         --arg prompt "$cron_prompt" --arg recurring "$recurring_bool" \
         --arg now "$now" '
        .entries += [{
          key: $key,
          cron: $cron,
          prompt: $prompt,
          recurring: ($recurring == "true"),
          source: "ad-hoc",
          note: "Adopted from CronList",
          createdAt: $now,
          lastSeenAlive: $now,
          harnessTaskId: $id,
          paused: false,
          tombstone: null,
          adoptedAt: $now
        }] |
        .updatedAt = $now
      ' "$REGISTRY" | write_atomic
    fi
  done <<< "$input"

  # Format-drift guard: non-empty input but 0 matched → loud abort (Delta #8).
  if [[ $line_count -gt 0 && $matched_count -eq 0 ]]; then
    log_error "harness shape drift: CronList output did not match expected regex"
    echo "writeback.sh adopt-unknown: harness shape drift — CronList output did not match expected format. See docs/crons.md." >&2
    echo "Raw input: $input" >&2
    exit 4
  fi
}

cmd_pause() {
  local key=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --key) key="$2"; shift 2;;
      *) echo "pause: unknown flag $1" >&2; exit 2;;
    esac
  done
  [[ -z "$key" ]] && { echo "pause: --key required" >&2; exit 2; }

  acquire_lock
  [[ -f "$REGISTRY" ]] || { echo "pause: no registry found" >&2; exit 1; }

  if ! jq -e --arg key "$key" '.entries | any(.key == $key)' "$REGISTRY" >/dev/null; then
    echo "pause: key '$key' not found in registry" >&2
    exit 1
  fi

  local now
  now=$(iso_now)
  jq --arg key "$key" --arg now "$now" '
    .entries |= map(
      if .key == $key then
        .paused = true | .harnessTaskId = null
      else . end
    ) |
    .updatedAt = $now
  ' "$REGISTRY" | write_atomic
}

cmd_resume() {
  local key="" harness_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --key) key="$2"; shift 2;;
      --harness-task-id) harness_id="$2"; shift 2;;
      *) echo "resume: unknown flag $1" >&2; exit 2;;
    esac
  done
  [[ -z "$key" ]] && { echo "resume: --key required" >&2; exit 2; }

  acquire_lock
  [[ -f "$REGISTRY" ]] || { echo "resume: no registry found" >&2; exit 1; }

  if ! jq -e --arg key "$key" '.entries | any(.key == $key)' "$REGISTRY" >/dev/null; then
    echo "resume: key '$key' not found in registry" >&2
    exit 1
  fi

  local now
  now=$(iso_now)
  jq --arg key "$key" --arg harness "$harness_id" --arg now "$now" '
    .entries |= map(
      if .key == $key then
        .paused = false |
        (if $harness == "" then . else .harnessTaskId = $harness | .lastSeenAlive = $now end)
      else . end
    ) |
    .updatedAt = $now
  ' "$REGISTRY" | write_atomic
}

cmd_migration_mark() {
  local value=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --value) value="$2"; shift 2;;
      *) echo "migration-mark: unknown flag $1" >&2; exit 2;;
    esac
  done

  [[ -z "$value" ]] && { echo "migration-mark: --value required" >&2; exit 2; }

  acquire_lock
  _ensure_registry

  local now
  now=$(iso_now)
  jq --arg value "$value" --arg now "$now" '
    .migration.openclawAnsweredAt = $value |
    .migration.openclawOffered = true |
    .updatedAt = $now
  ' "$REGISTRY" | write_atomic
}

# ------------------- dispatch -------------------

ensure_jq

case "$SUBCMD" in
  seed-defaults)  cmd_seed_defaults "$@";;
  upsert)         cmd_upsert "$@";;
  tombstone)      cmd_tombstone "$@";;
  set-alive)      cmd_set_alive "$@";;
  adopt-unknown)  cmd_adopt_unknown "$@";;
  pause)          cmd_pause "$@";;
  resume)         cmd_resume "$@";;
  migration-mark) cmd_migration_mark "$@";;
  ""|-h|--help)
    cat <<USAGE
writeback.sh — sole writer for memory/crons.json

Usage:
  writeback.sh seed-defaults
  writeback.sh upsert --source <src> --cron <expr> --prompt <p> --recurring <bool>
                      [--key <k>] [--harness-task-id <id>] [--note <n>]
  writeback.sh tombstone {--key <k> | --harness-task-id <id>}
  writeback.sh set-alive --key <k> --harness-task-id <id>
  writeback.sh adopt-unknown < <cronlist-output>
  writeback.sh pause --key <k>
  writeback.sh resume --key <k> [--harness-task-id <id>]
  writeback.sh migration-mark --value <imported|declined|auto-imported>

Env:
  CLAUDE_PROJECT_DIR  Root of the agent workspace (default: \$PWD).
USAGE
    exit 0
    ;;
  *)
    echo "writeback.sh: unknown subcommand '$SUBCMD'" >&2
    echo "Run writeback.sh --help for usage." >&2
    exit 2
    ;;
esac
