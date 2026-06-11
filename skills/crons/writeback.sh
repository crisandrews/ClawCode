#!/usr/bin/env bash
# writeback.sh — sole writer for memory/crons.json
# Called by hooks/reconcile-crons.sh, hooks/cron-posttool.sh, and skills/crons/SKILL.md.
# See docs/crons.md for the registry schema and the full lifecycle.
set -uo pipefail

# Same PATH prefix as the hooks so jq is visible when writeback.sh is
# invoked from a systemd/launchd context that strips ~/.local/bin from
# the inherited PATH. Callers in interactive shells are unaffected.
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

AGENT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
MEMORY_DIR="$AGENT_ROOT/memory"
REGISTRY="$MEMORY_DIR/crons.json"
LOCK_DIR="$MEMORY_DIR/.crons-lock"
ERRORS_LOG="$MEMORY_DIR/crons-errors.jsonl"
SUBCMD="${1:-}"
shift || true

iso_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# --- BSD/GNU date shims (used by prune-expired's suspect report) ---
# Value-checked probes, GNU first: on GNU `date -r 1` means "mtime of a file
# named 1", so an exit-code-only probe misclassifies GNU as BSD when such a
# file exists in $PWD. Same convention as bin/cron-from.sh.
_detect_date_flavor() {
  if [[ "$(date -u -d "@1" +%s 2>/dev/null)" == "1" ]]; then echo gnu
  elif [[ "$(date -u -r 1 +%s 2>/dev/null)" == "1" ]]; then echo bsd
  else echo none; fi
}

_epoch_fmt() { # <epoch> <fmt>
  if [[ "$DATE_FLAVOR" == "bsd" ]]; then
    date -r "$1" +"$2" 2>/dev/null
  else
    date -d "@$1" +"$2" 2>/dev/null
  fi
}

_parse_local_to_epoch() { # "YYYY-MM-DD HH:MM" (host-local time)
  if [[ "$DATE_FLAVOR" == "bsd" ]]; then
    date -j -f "%Y-%m-%d %H:%M" "$1" +%s 2>/dev/null
  else
    date -d "$1" +%s 2>/dev/null
  fi
}

# Refresh the .reconciling marker ONLY while it is still fresh (<10 min,
# matching hooks/cron-pretool.sh MAX_RECONCILE_AGE_SEC). A blind touch would
# resurrect a STALE marker left by a crashed reconcile — silently reopening
# the CronCreate stamp bypass and the PostToolUse capture suppression for
# whoever runs set-alive/audit next (e.g. a routine LIST). Stale markers are
# left alone; cron-pretool removes them on its next gated call.
_refresh_reconciling_if_fresh() {
  local marker="$MEMORY_DIR/.reconciling"
  [[ -f "$marker" ]] || return 0
  local marker_mtime now_s age
  marker_mtime=$(stat -f %m "$marker" 2>/dev/null || stat -c %Y "$marker" 2>/dev/null || echo 0)
  now_s=$(date +%s)
  age=$((now_s - marker_mtime))
  if [[ $age -ge 0 && $age -lt 600 ]]; then
    touch "$marker" 2>/dev/null || true
  fi
}

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
      "adoptedAt": null,
      "targetEpoch": null
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
      "adoptedAt": null,
      "targetEpoch": null
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
      adoptedAt: null,
      targetEpoch: null
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
  local key="" harness_id="" source="" cron="" prompt="" recurring="true" note="" target_epoch=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --key) key="$2"; shift 2;;
      --harness-task-id) harness_id="$2"; shift 2;;
      --source) source="$2"; shift 2;;
      --cron) cron="$2"; shift 2;;
      --prompt) prompt="$2"; shift 2;;
      --recurring) recurring="$2"; shift 2;;
      --note) note="$2"; shift 2;;
      --target-epoch) target_epoch="$2"; shift 2;;
      *) echo "writeback.sh upsert: unknown flag $1" >&2; exit 2;;
    esac
  done

  [[ -z "$cron" ]] && { echo "upsert: --cron required" >&2; exit 2; }
  [[ -z "$prompt" ]] && { echo "upsert: --prompt required" >&2; exit 2; }
  [[ -z "$source" ]] && { echo "upsert: --source required" >&2; exit 2; }
  if [[ -n "$target_epoch" && ! "$target_epoch" =~ ^[0-9]+$ ]]; then
    echo "upsert: --target-epoch must be epoch seconds (got '$target_epoch')" >&2; exit 2
  fi

  if [[ -z "$key" ]]; then
    [[ -z "$harness_id" ]] && { echo "upsert: either --key or --harness-task-id required" >&2; exit 2; }
    key="harness-$harness_id"
  fi

  acquire_lock
  _ensure_registry

  # Duplicate guard: reject if an active (tombstone=null) entry with the
  # same cron + prompt already exists under a different key. Blocks the
  # "PostToolUse hook captured as harness-<id>, then manual upsert with a
  # custom key" pattern that silently creates double-firing reminders.
  # openclaw-import is exempt — legitimate imports may carry repeated
  # payloads across agents during a one-shot batch.
  if [[ "$source" != "openclaw-import" ]]; then
    local existing_key
    existing_key=$(jq -r --arg cron "$cron" --arg prompt "$prompt" --arg key "$key" '
      .entries
      | map(select(.tombstone == null and .cron == $cron and .prompt == $prompt and .key != $key))
      | first
      | .key // empty
    ' "$REGISTRY")

    if [[ -n "$existing_key" ]]; then
      log_error "duplicate: same cron+prompt already present as '$existing_key'"
      echo "writeback.sh upsert: refused — an active entry with the same cron+prompt already exists as '$existing_key'." >&2
      echo "  • If this is a stale entry, tombstone it first: writeback.sh tombstone --key '$existing_key'" >&2
      echo "  • If you intended to register an ad-hoc CronCreate, the PostToolUse hook already captured it automatically — remove this manual upsert call (see skills/crons/SKILL.md ⛔ rule #4)." >&2
      exit 5
    fi
  fi

  local now
  now=$(iso_now)

  jq --arg key "$key" --arg src "$source" --arg cron "$cron" --arg prompt "$prompt" \
     --arg recurring "$recurring" --arg note "$note" --arg harness "$harness_id" \
     --arg tepoch "$target_epoch" \
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
          .targetEpoch = (if $tepoch == "" then (.targetEpoch // null) else ($tepoch | tonumber) end) |
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
        adoptedAt: null,
        targetEpoch: (if $tepoch == "" then null else ($tepoch | tonumber) end)
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

  # Sliding reconcile marker: set-alive runs after every recreated cron
  # during the SessionStart reconcile envelope, so refreshing the marker
  # here keeps the hooks' 10-minute bypass window open exactly as long as
  # the reconcile keeps making real progress (chat interleaving between
  # batches no longer expires it). Refresh ONLY if present AND still fresh —
  # set-alive outside a reconcile must never create the bypass, and a stale
  # marker from a crashed reconcile must not be silently resurrected.
  _refresh_reconciling_if_fresh
}

cmd_audit() {
  # Mechanical diff of CronList output (stdin) against the registry.
  # This is the completion check Issue #32 asked for: the agent-executed
  # reconcile can partially fail (turn budget, interleaved chat, per-entry
  # errors), and until now nothing verified the post-reconcile state.
  #
  # stdin contract: the FULL CronList output — one line per alive job
  #   "<8hex-id> — <cron-expr> (recurring|one-shot) [session-only|durable]: <prompt>"
  # or the literal "No scheduled jobs.". STRICT: blank stdin and any
  # unparseable non-empty line are format drift (exit 4, nothing persisted) —
  # a broken pipe must never mark every reminder orphaned.
  #
  # Effects (single jq pass, atomic, lock-held):
  #   - active entries whose harnessTaskId is alive → lastSeenAlive=now
  #   - safe relink: an orphaned entry whose (cron,prompt,recurring) triple
  #     matches EXACTLY ONE unclaimed live row — and is itself the only
  #     orphan with that triple — gets that row's id instead of a recreate
  #     (handles "CronCreate succeeded, set-alive never ran").
  #   - BLOCKED (never guess, never auto-recreate): an orphaned entry whose
  #     triple matches ≥1 unclaimed live row but can't be relinked
  #     unambiguously (multiple candidates, or multiple orphan twins). Auto-
  #     recreating those would add a THIRD copy next to live duplicates from
  #     prior partial successes — they are surfaced for manual resolution.
  #   - persists top-level .audit = {at, expected, alive, orphaned, relinked,
  #     blocked, unknown, orphanKeys[], blockedKeys[]} for offline readers.
  # stdout: "relinked key=… id=…" / "orphan key=… cron=…" /
  #   "blocked key=… cron=… reason=ambiguous-live-match" lines, then one
  #   "audit: alive=K/N orphaned=X relinked=L blocked=B unknown=M" summary.
  # Repair contract for callers: recreate ONLY "orphan key=" lines; report
  #   "blocked key=" lines to the user; skip adopt-unknown while blocked>0.
  # Exit 0 (report-only; orphans are data, not an error). Exit 4 on drift.
  acquire_lock
  if [[ ! -f "$REGISTRY" ]]; then
    echo "audit: alive=0/0 orphaned=0 relinked=0 blocked=0 unknown=0 (no registry)"
    return 0
  fi
  if ! jq -e '.version == 1 and has("entries")' "$REGISTRY" >/dev/null 2>&1; then
    echo "audit: registry invalid; skipped (next seed-defaults quarantines it)" >&2
    return 0
  fi

  local input
  input=$(cat)

  local stripped
  stripped=$(printf '%s\n' "$input" | sed -e 's/[[:space:]]*$//' | grep -v '^$' || true)

  local live_rows="[]"
  if [[ -z "$stripped" ]]; then
    log_error "audit: blank stdin (expected CronList output or 'No scheduled jobs.')"
    echo "writeback.sh audit: blank input — pipe the FULL CronList output (or the literal 'No scheduled jobs.'). Nothing was persisted." >&2
    exit 4
  fi

  if [[ "$stripped" != "No scheduled jobs." ]]; then
    local line rows_jsonl=""
    while IFS= read -r line; do
      line="${line%$'\r'}"
      [[ -z "${line//[[:space:]]/}" ]] && continue
      if [[ "$line" =~ ^([0-9a-f]{8})\ —\ (.+)\ \((recurring|one-shot)\)\ \[(session-only|durable)\]:\ (.+)$ ]]; then
        local task_id="${BASH_REMATCH[1]}"
        local cron_expr="${BASH_REMATCH[2]}"
        local kind="${BASH_REMATCH[3]}"
        local cron_prompt="${BASH_REMATCH[5]}"
        local rec="false"
        [[ "$kind" == "recurring" ]] && rec="true"
        rows_jsonl+=$(jq -nc --arg id "$task_id" --arg cron "$cron_expr" \
          --arg prompt "$cron_prompt" --argjson recurring "$rec" \
          '{id:$id,cron:$cron,prompt:$prompt,recurring:$recurring}')$'\n'
      else
        log_error "audit: harness shape drift: unparseable CronList line"
        echo "writeback.sh audit: harness shape drift — a non-empty line did not match the CronList contract:" >&2
        echo "  $line" >&2
        echo "Nothing was persisted. See docs/crons.md." >&2
        exit 4
      fi
    done <<< "$input"
    live_rows=$(printf '%s' "$rows_jsonl" | jq -sc '.' 2>/dev/null || echo "[]")
  fi

  local now
  now=$(iso_now)
  local updated
  updated=$(jq --argjson live "$live_rows" --arg now "$now" '
    def triple(e): {cron: e.cron, prompt: e.prompt, recurring: e.recurring};
    ($live | map(.id)) as $liveIds |
    ([.entries[].harnessTaskId | select(. != null)]) as $claimed |
    ([.entries[] | select(.paused == false and .tombstone == null)]) as $active |
    ([$active[] | select((.harnessTaskId == null) or (.harnessTaskId as $h | ($liveIds | any(. == $h)) | not))]) as $orphans |
    ([$live[] | select(.id as $i | ($claimed | any(. == $i)) | not)]) as $unclaimed |
    .entries |= map(
      if (.paused == false and .tombstone == null) then
        if ((.harnessTaskId != null) and (.harnessTaskId as $h | ($liveIds | any(. == $h)))) then
          .lastSeenAlive = $now
        else
          triple(.) as $t |
          ([$orphans[] | select(triple(.) == $t)]) as $twins |
          ([$unclaimed[] | select(.cron == $t.cron and .prompt == $t.prompt and .recurring == $t.recurring)]) as $cands |
          if (($twins | length) == 1 and ($cands | length) == 1) then
            .harnessTaskId = $cands[0].id | .lastSeenAlive = $now | ._relinked = true
          elif (($cands | length) >= 1) then
            ._blocked = true
          else
            .
          end
        end
      else . end
    ) |
    ([.entries[] | select(.paused == false and .tombstone == null)]) as $activeAfter |
    ([$activeAfter[] | select(._blocked == true) | {key: .key, cron: .cron}]) as $blockedRows |
    ([$activeAfter[] | select((._blocked != true) and ((.harnessTaskId == null) or (.harnessTaskId as $h | ($liveIds | any(. == $h)) | not))) | {key: .key, cron: .cron}]) as $orphanRows |
    ([.entries[].harnessTaskId | select(. != null)]) as $claimedAfter |
    ([$liveIds[] | select(. as $i | ($claimedAfter | any(. == $i)) | not)]) as $unknownIds |
    ([.entries[] | select(._relinked == true) | {key: .key, id: .harnessTaskId}]) as $relinked |
    .entries |= map(del(._relinked) | del(._blocked)) |
    .audit = {
      at: $now,
      expected: ($activeAfter | length),
      alive: (($activeAfter | length) - ($orphanRows | length) - ($blockedRows | length)),
      orphaned: ($orphanRows | length),
      relinked: ($relinked | length),
      blocked: ($blockedRows | length),
      unknown: ($unknownIds | length),
      orphanKeys: ($orphanRows | map(.key)),
      blockedKeys: ($blockedRows | map(.key))
    } |
    ._report = {orphanRows: $orphanRows, blockedRows: $blockedRows, relinked: $relinked, audit: .audit} |
    .updatedAt = $now
  ' "$REGISTRY" 2>/dev/null || true)

  # Write safety (same rationale as prune-expired): only install a full,
  # valid registry — a failed jq piped into write_atomic would replace the
  # registry with an empty file.
  if [[ -z "$updated" ]] || ! printf '%s' "$updated" \
      | jq -e '.version == 1 and (.entries | type == "array") and has("_report")' >/dev/null 2>&1; then
    log_error "audit: transform produced invalid registry; write aborted"
    echo "writeback.sh audit: transform failed; registry left untouched" >&2
    exit 1
  fi

  local report final
  report=$(printf '%s' "$updated" | jq -c '._report')
  final=$(printf '%s' "$updated" | jq 'del(._report)' 2>/dev/null || true)
  if [[ -z "$final" ]] || ! printf '%s' "$final" \
      | jq -e '.version == 1 and (.entries | type == "array")' >/dev/null 2>&1; then
    log_error "audit: report strip produced invalid registry; write aborted"
    echo "writeback.sh audit: transform failed; registry left untouched" >&2
    exit 1
  fi
  printf '%s\n' "$final" | write_atomic

  # Keep the reconcile bypass window sliding through verification + retry,
  # but never resurrect a stale marker (see _refresh_reconciling_if_fresh).
  _refresh_reconciling_if_fresh

  printf '%s' "$report" | jq -r '
    (.relinked[] | "relinked key=\(.key) id=\(.id)"),
    (.orphanRows[] | "orphan key=\(.key) cron=\"\(.cron)\""),
    (.blockedRows[] | "blocked key=\(.key) cron=\"\(.cron)\" reason=ambiguous-live-match"),
    "audit: alive=\(.audit.alive)/\(.audit.expected) orphaned=\(.audit.orphaned) relinked=\(.audit.relinked) blocked=\(.audit.blocked) unknown=\(.audit.unknown)"
  '
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
          adoptedAt: $now,
          targetEpoch: null
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

cmd_prune_expired() {
  # Tombstones one-shot entries whose explicit targetEpoch already passed,
  # and reports (NEVER mutates) legacy date-shaped entries that look expired
  # but predate the targetEpoch field. Shaped by the 2026-06-09 adversarial
  # review: a 5-field cron carries no year, so date-math alone cannot safely
  # decide expiry — only explicit creation-time metadata can. Without this,
  # every SessionStart reconcile resurrects already-fired dated reminders
  # (they next fire a full year later).
  acquire_lock
  [[ -f "$REGISTRY" ]] || { echo "prune-expired: pruned=0 suspects=0 (no registry)"; return 0; }
  if ! jq -e '.version == 1 and has("entries")' "$REGISTRY" >/dev/null 2>&1; then
    echo "prune-expired: registry invalid; skipped (next seed-defaults quarantines it)" >&2
    return 0
  fi

  local now_epoch now_iso
  now_epoch=$(date +%s)
  now_iso=$(iso_now)

  # --- 1. Epoch-based prune (authoritative, zero heuristics) ---
  local pruned_keys
  pruned_keys=$(jq -r --argjson now "$now_epoch" '
    [ .entries[]
      | select(.paused == false and .tombstone == null and .recurring == false)
      | select((.targetEpoch // null) != null and .targetEpoch < $now)
      | .key
    ] | .[]
  ' "$REGISTRY" 2>/dev/null || true)

  local pruned_count=0
  if [[ -n "$pruned_keys" ]]; then
    local updated
    updated=$(jq --arg now "$now_iso" --argjson nowE "$now_epoch" '
      .entries |= map(
        if .paused == false and .tombstone == null and .recurring == false
           and ((.targetEpoch // null) != null) and .targetEpoch < $nowE then
          .tombstone = $now
          | .note = (((.note // "") | if . == "" then "" else . + " " end)
                     + "[auto-pruned " + $now + ": one-shot targetEpoch passed]")
        else . end
      ) |
      .updatedAt = $now
    ' "$REGISTRY" 2>/dev/null || true)
    # Write safety: only install a full, valid registry — a failed jq piped
    # straight into write_atomic would replace the registry with an empty
    # file (later quarantined, all tombstone history lost).
    if [[ -n "$updated" ]] && printf '%s' "$updated" \
        | jq -e '.version == 1 and (.entries | type == "array")' >/dev/null 2>&1; then
      printf '%s\n' "$updated" | write_atomic
      while IFS= read -r _k; do
        [[ -z "$_k" ]] && continue
        pruned_count=$((pruned_count + 1))
        echo "pruned key=$_k"
      done <<< "$pruned_keys"
    else
      log_error "prune-expired: transform produced invalid registry; write aborted"
      echo "prune-expired: transform failed; registry left untouched" >&2
    fi
  fi

  # --- 2. Legacy suspect report (REPORT-ONLY) ---
  # Entries created before targetEpoch existed: date-shaped cron (numeric
  # min/hour/dom/month, dow *) whose first occurrence after createdAt has
  # already passed. The year is genuinely ambiguous for these, so they are
  # surfaced for the user to verify and delete — never auto-tombstoned.
  # Annual-protection: recurring entries are flagged only when created
  # within 7 days of the computed occurrence (a "remind me tonight" that
  # the capture default marked recurring); intentional annuals stay quiet.
  local suspect_count=0
  DATE_FLAVOR=$(_detect_date_flavor)
  if [[ "$DATE_FLAVOR" != "none" ]]; then
    local entry key cron created_iso created_epoch recurring cy
    local m h d mo y cand rt_m rt_d first_occ
    while IFS= read -r entry; do
      [[ -z "$entry" ]] && continue
      cron=$(jq -r '.cron' <<<"$entry" 2>/dev/null) || continue
      [[ "$cron" =~ ^([0-9]{1,2})\ ([0-9]{1,2})\ ([0-9]{1,2})\ ([0-9]{1,2})\ \*$ ]] || continue
      m="${BASH_REMATCH[1]}"; h="${BASH_REMATCH[2]}"; d="${BASH_REMATCH[3]}"; mo="${BASH_REMATCH[4]}"
      key=$(jq -r '.key' <<<"$entry" 2>/dev/null)
      recurring=$(jq -r '.recurring' <<<"$entry" 2>/dev/null)
      created_iso=$(jq -r '.createdAt // empty' <<<"$entry" 2>/dev/null)
      [[ -z "$created_iso" ]] && continue
      created_epoch=$(jq -rn --arg t "$created_iso" '($t | fromdateiso8601?) // empty' 2>/dev/null)
      [[ -z "$created_epoch" ]] && continue
      cy=$(_epoch_fmt "$created_epoch" "%Y")
      [[ -z "$cy" ]] && continue
      first_occ=""
      for y in "$cy" "$((cy + 1))" "$((cy + 2))"; do
        cand=$(_parse_local_to_epoch "$(printf '%04d-%02d-%02d %02d:%02d' "$y" "$((10#$mo))" "$((10#$d))" "$((10#$h))" "$((10#$m))")")
        [[ -z "$cand" ]] && continue
        # Round-trip guard, month/day only (the hour may legally shift
        # across a DST gap): BSD `date -j -f` NORMALIZES invalid calendar
        # dates (Feb 30 → Mar 2) instead of failing like GNU.
        rt_m=$(_epoch_fmt "$cand" "%-m"); rt_d=$(_epoch_fmt "$cand" "%-d")
        [[ "$rt_m" == "$((10#$mo))" && "$rt_d" == "$((10#$d))" ]] || continue
        if (( cand > created_epoch )); then first_occ="$cand"; break; fi
      done
      [[ -z "$first_occ" ]] && continue
      (( now_epoch > first_occ )) || continue
      if [[ "$recurring" == "false" ]] || (( first_occ - created_epoch <= 604800 )); then
        suspect_count=$((suspect_count + 1))
        echo "suspect key=$key cron=\"$cron\" expected=$(_epoch_fmt "$first_occ" "%Y-%m-%d %H:%M")"
      fi
    done < <(jq -c '.entries[] | select(.paused == false and .tombstone == null and ((.targetEpoch // null) == null))' "$REGISTRY" 2>/dev/null || true)
  fi

  echo "prune-expired: pruned=$pruned_count suspects=$suspect_count"
}

# ------------------- dispatch -------------------

ensure_jq

case "$SUBCMD" in
  seed-defaults)  cmd_seed_defaults "$@";;
  upsert)         cmd_upsert "$@";;
  tombstone)      cmd_tombstone "$@";;
  set-alive)      cmd_set_alive "$@";;
  adopt-unknown)  cmd_adopt_unknown "$@";;
  audit)          cmd_audit "$@";;
  pause)          cmd_pause "$@";;
  resume)         cmd_resume "$@";;
  migration-mark) cmd_migration_mark "$@";;
  prune-expired)  cmd_prune_expired "$@";;
  ""|-h|--help)
    cat <<USAGE
writeback.sh — sole writer for memory/crons.json

Usage:
  writeback.sh seed-defaults
  writeback.sh upsert --source <src> --cron <expr> --prompt <p> --recurring <bool>
                      [--key <k>] [--harness-task-id <id>] [--note <n>]
                      [--target-epoch <epoch-seconds>]
  writeback.sh tombstone {--key <k> | --harness-task-id <id>}
  writeback.sh set-alive --key <k> --harness-task-id <id>
  writeback.sh adopt-unknown < <cronlist-output>
  writeback.sh audit < <cronlist-output>
  writeback.sh pause --key <k>
  writeback.sh resume --key <k> [--harness-task-id <id>]
  writeback.sh migration-mark --value <imported|declined|auto-imported>
  writeback.sh prune-expired

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
