#!/usr/bin/env bash
# cron-from.sh — deterministic cron expression generator.
#
# Why this exists: LLMs are unreliable at time arithmetic (mix UTC/local,
# miscount minutes across hour boundaries, hallucinate DST). This helper
# does the math. Skills MUST call it instead of computing cron expressions
# in prompt context.
#
# Daemon contract: Claude Code's cron daemon interprets expressions in the
# host's LOCAL time (verified empirically 2026-04-19). All output here is
# in host-local time so cron fires when expected.
#
# Usage:
#   bin/cron-from.sh relative <N> <minutes|hours|days>
#   bin/cron-from.sh absolute "HH:MM"             # today if future, tomorrow if past
#   bin/cron-from.sh absolute "HH:MM tomorrow"
#   bin/cron-from.sh recurring daily "HH:MM"
#   bin/cron-from.sh recurring weekly <dow> "HH:MM"   # dow: mon|tue|...|sun or 0..6 (0=sun)
#   bin/cron-from.sh recurring every <N> <minutes|hours>
#
# Output (stdout, single line JSON):
#   {"cron":"52 12 19 4 *","human_local":"12:52 (dom 19 abr)",
#    "iso_local":"2026-04-19T12:52:00-04:00","epoch":1745087520,
#    "recurring":false,"kind":"relative"}
#
# For recurring outputs: epoch and iso_local are null, human_local describes
# the schedule ("daily at 09:00", "weekly on mon at 08:00", "every 30 minutes").
#
# Exit codes:
#   0 — success
#   2 — invalid arguments
#   3 — date arithmetic failure (caller should report verbatim)
set -uo pipefail

# --- platform detection (BSD vs GNU date) ---
if date -r 1 +%s >/dev/null 2>&1; then
  DATE_FLAVOR="bsd"
elif date -d "@1" +%s >/dev/null 2>&1; then
  DATE_FLAVOR="gnu"
else
  echo "cron-from.sh: cannot detect date flavor (neither BSD nor GNU)" >&2
  exit 3
fi

# --- platform shims ---
# Format an epoch into a date field (e.g. %M, %H, %Y-%m-%d, etc.)
epoch_fmt() {
  local epoch="$1" fmt="$2"
  if [[ "$DATE_FLAVOR" == "bsd" ]]; then
    date -r "$epoch" +"$fmt"
  else
    date -d "@$epoch" +"$fmt"
  fi
}

# Parse "YYYY-MM-DD HH:MM" (local time) into epoch seconds.
parse_local_to_epoch() {
  local input="$1"  # "YYYY-MM-DD HH:MM"
  if [[ "$DATE_FLAVOR" == "bsd" ]]; then
    date -j -f "%Y-%m-%d %H:%M" "$input" +%s 2>/dev/null
  else
    date -d "$input" +%s 2>/dev/null
  fi
}

# Add days to a YYYY-MM-DD, return new YYYY-MM-DD (local).
add_days_to_date() {
  local ymd="$1" days="$2"
  if [[ "$DATE_FLAVOR" == "bsd" ]]; then
    date -j -v "+${days}d" -f "%Y-%m-%d" "$ymd" +"%Y-%m-%d" 2>/dev/null
  else
    date -d "$ymd + $days days" +"%Y-%m-%d" 2>/dev/null
  fi
}

# --- helpers ---
fail_args() { echo "cron-from.sh: $1" >&2; exit 2; }
fail_date() { echo "cron-from.sh: date arithmetic failed: $1" >&2; exit 3; }

is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }

# Validate HH:MM form, return "HH MM" with leading zeros stripped (for cron).
parse_hhmm() {
  local hhmm="$1"
  [[ "$hhmm" =~ ^([0-9]{1,2}):([0-9]{2})$ ]] || return 1
  local h="${BASH_REMATCH[1]}" m="${BASH_REMATCH[2]}"
  # Strip leading zeros for arithmetic comparison.
  local h_int=$((10#$h)) m_int=$((10#$m))
  (( h_int >= 0 && h_int <= 23 )) || return 1
  (( m_int >= 0 && m_int <= 59 )) || return 1
  echo "$h_int $m_int"
}

# Normalize day-of-week to numeric (0=sun, 6=sat).
normalize_dow() {
  local dow="$1"
  case "$(echo "$dow" | tr '[:upper:]' '[:lower:]')" in
    sun|sunday|0)    echo 0 ;;
    mon|monday|1)    echo 1 ;;
    tue|tuesday|2)   echo 2 ;;
    wed|wednesday|3) echo 3 ;;
    thu|thursday|4)  echo 4 ;;
    fri|friday|5)    echo 5 ;;
    sat|saturday|6)  echo 6 ;;
    *) return 1 ;;
  esac
}

# Emit a one-shot output JSON given a target epoch.
emit_oneshot() {
  local epoch="$1" kind="$2"
  local cron_min cron_hour cron_day cron_month
  cron_min=$(epoch_fmt "$epoch" "%-M") || fail_date "extract minute"
  cron_hour=$(epoch_fmt "$epoch" "%-H") || fail_date "extract hour"
  cron_day=$(epoch_fmt "$epoch" "%-d") || fail_date "extract day"
  cron_month=$(epoch_fmt "$epoch" "%-m") || fail_date "extract month"
  local cron="$cron_min $cron_hour $cron_day $cron_month *"
  local human iso
  human=$(epoch_fmt "$epoch" "%H:%M (%a %d %b)")
  iso=$(epoch_fmt "$epoch" "%Y-%m-%dT%H:%M:%S%z")
  jq -nc \
    --arg cron "$cron" \
    --arg human "$human" \
    --arg iso "$iso" \
    --argjson epoch "$epoch" \
    --arg kind "$kind" \
    '{cron:$cron, human_local:$human, iso_local:$iso, epoch:$epoch, recurring:false, kind:$kind}'
}

# Emit a recurring output JSON.
emit_recurring() {
  local cron="$1" human="$2" kind="$3"
  jq -nc \
    --arg cron "$cron" \
    --arg human "$human" \
    --arg kind "$kind" \
    '{cron:$cron, human_local:$human, iso_local:null, epoch:null, recurring:true, kind:$kind}'
}

# --- subcommands ---
cmd_relative() {
  local n="$1" unit="$2"
  is_uint "$n" || fail_args "relative N must be a non-negative integer (got '$n')"
  local seconds
  case "$(echo "$unit" | tr '[:upper:]' '[:lower:]')" in
    m|min|mins|minute|minutes) seconds=$((n * 60)) ;;
    h|hr|hrs|hour|hours)       seconds=$((n * 3600)) ;;
    d|day|days)                seconds=$((n * 86400)) ;;
    *) fail_args "unknown unit '$unit' (expected minutes|hours|days)" ;;
  esac
  local now target
  now=$(date +%s)
  target=$((now + seconds))
  emit_oneshot "$target" "relative"
}

cmd_absolute() {
  local time_arg="$1" tomorrow_flag="${2:-}"
  local hm
  hm=$(parse_hhmm "$time_arg") || fail_args "invalid time '$time_arg' (expected HH:MM)"
  local h_int m_int
  read -r h_int m_int <<<"$hm"
  local today
  today=$(date +"%Y-%m-%d")
  local hh mm
  hh=$(printf "%02d" "$h_int")
  mm=$(printf "%02d" "$m_int")
  local target_today_epoch
  target_today_epoch=$(parse_local_to_epoch "$today $hh:$mm") || fail_date "parse today $hh:$mm"
  local now epoch_target ymd
  now=$(date +%s)
  if [[ "$tomorrow_flag" == "tomorrow" ]]; then
    ymd=$(add_days_to_date "$today" 1) || fail_date "add 1 day"
    epoch_target=$(parse_local_to_epoch "$ymd $hh:$mm") || fail_date "parse tomorrow $hh:$mm"
  elif (( target_today_epoch > now )); then
    epoch_target=$target_today_epoch
  else
    ymd=$(add_days_to_date "$today" 1) || fail_date "add 1 day (rollover)"
    epoch_target=$(parse_local_to_epoch "$ymd $hh:$mm") || fail_date "parse rollover $hh:$mm"
  fi
  emit_oneshot "$epoch_target" "absolute"
}

cmd_recurring() {
  local sub="$1"; shift
  case "$sub" in
    daily)
      [[ $# -ge 1 ]] || fail_args "recurring daily requires HH:MM"
      local hm; hm=$(parse_hhmm "$1") || fail_args "invalid time '$1'"
      local h m; read -r h m <<<"$hm"
      emit_recurring "$m $h * * *" "daily at $(printf '%02d:%02d' "$h" "$m")" "recurring-daily"
      ;;
    weekly)
      [[ $# -ge 2 ]] || fail_args "recurring weekly requires <dow> HH:MM"
      local dow_in="$1" time_in="$2"
      local dow; dow=$(normalize_dow "$dow_in") || fail_args "invalid day-of-week '$dow_in'"
      local hm; hm=$(parse_hhmm "$time_in") || fail_args "invalid time '$time_in'"
      local h m; read -r h m <<<"$hm"
      local dow_lower; dow_lower=$(echo "$dow_in" | tr '[:upper:]' '[:lower:]')
      emit_recurring "$m $h * * $dow" "weekly on $dow_lower at $(printf '%02d:%02d' "$h" "$m")" "recurring-weekly"
      ;;
    every)
      [[ $# -ge 2 ]] || fail_args "recurring every requires <N> <minutes|hours>"
      local n="$1" unit="$2"
      is_uint "$n" || fail_args "every N must be a positive integer (got '$n')"
      (( n >= 1 )) || fail_args "every N must be >= 1"
      case "$(echo "$unit" | tr '[:upper:]' '[:lower:]')" in
        m|min|mins|minute|minutes)
          (( n <= 59 )) || fail_args "every N minutes must be <= 59 (got $n; use 'every 1 hour' or larger units instead)"
          emit_recurring "*/$n * * * *" "every $n minutes" "recurring-every-min"
          ;;
        h|hr|hrs|hour|hours)
          (( n <= 23 )) || fail_args "every N hours must be <= 23 (got $n)"
          emit_recurring "0 */$n * * *" "every $n hours (on the hour)" "recurring-every-hr"
          ;;
        *) fail_args "unknown unit '$unit' (expected minutes|hours)" ;;
      esac
      ;;
    *) fail_args "unknown recurring subcommand '$sub' (expected daily|weekly|every)" ;;
  esac
}

# --- entry point ---
main() {
  [[ $# -ge 1 ]] || fail_args "usage: see 'head -40 $0'"
  command -v jq >/dev/null 2>&1 || { echo "cron-from.sh: jq is required" >&2; exit 3; }
  local cmd="$1"; shift
  case "$cmd" in
    relative)
      [[ $# -eq 2 ]] || fail_args "relative requires <N> <unit>"
      cmd_relative "$1" "$2"
      ;;
    absolute)
      [[ $# -ge 1 && $# -le 2 ]] || fail_args "absolute requires \"HH:MM\" [tomorrow]"
      cmd_absolute "$@"
      ;;
    recurring)
      [[ $# -ge 1 ]] || fail_args "recurring requires subcommand (daily|weekly|every)"
      cmd_recurring "$@"
      ;;
    *) fail_args "unknown command '$cmd' (expected relative|absolute|recurring)" ;;
  esac
}

main "$@"
