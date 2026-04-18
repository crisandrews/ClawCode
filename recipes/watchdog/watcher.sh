#!/usr/bin/env bash
# ClawCode Watchdog — one-shot health probe.
#
# Runs up to 6 tiered checks against a ClawCode service. If any check fails
# and we are not in cooldown, triggers --on-fail (default: restart via the
# service manager) and optionally --alert-cmd.
#
# Designed to be invoked by a systemd user timer (Linux) or launchd
# StartInterval (macOS) — NOT a long-running daemon. Each invocation lives
# ~50ms and exits.
#
# Logs one line per tick to --log-path (default /tmp/clawcode-watchdog-<label>.log).
# On failure + restart, also appends the last 30 lines of the service log for
# later diagnosis.
#
# Usage:
#   watcher.sh \
#     --service-label=clawcode-myagent \
#     --slug=myagent \
#     --workspace=/home/me/myagent \
#     --http-port=18790 \
#     --http-token='' \
#     --expected-plugins=telegram,whatsapp \
#     --tier=1 --tier=2 --tier=3 --tier=4 --tier=6 \
#     --cooldown=300 \
#     --on-fail='systemctl --user restart clawcode-myagent' \
#     --alert-cmd='./alert-telegram.sh' \
#     --log-path=/tmp/clawcode-watchdog-myagent.log
#
# Tier 6 (version drift) is opt-in: pass --tier=6 and --slug=<slug>. Detects
# the "git pull but service not restarted" case by diffing the stamp file
# the service writes at boot (see docs/service.md > Version stamp) against
# the current HEAD of --workspace. On drift, triggers --on-fail like any
# other tier failure; the restart causes the stamp to be rewritten.
#
# Exit codes:
#   0 = all checks passed (or SKIP due to cooldown after a fresh restart)
#   1 = at least one check failed
#   2 = bad arguments

set -o pipefail

# ---------------- Defaults ----------------
SERVICE_LABEL=""
SLUG=""
WORKSPACE=""
TIERS=""
HTTP_PORT="18790"
HTTP_TOKEN="${CLAWCODE_HTTP_TOKEN:-}"
EXPECTED_PLUGINS=""
COOLDOWN="300"
ON_FAIL=""
ALERT_CMD=""
LOG_PATH=""
# Tier 5 (LLM ping) has its own cadence because it costs tokens. Default
# 3600s = once per hour. Use 0 to run on every tick (not recommended).
LLM_PING_INTERVAL="3600"
# Maximum wait inside the endpoint for the PONG response
LLM_PING_TIMEOUT_MS="30000"
# Tier 6 (version drift): explicit stamp path override, otherwise derived
# from $SLUG + platform per versionStampPathExpr in lib/service-generator.ts.
STAMP_FILE=""

# ---------------- Parse args ----------------
for arg in "$@"; do
  case "$arg" in
    --service-label=*)    SERVICE_LABEL="${arg#*=}" ;;
    --slug=*)             SLUG="${arg#*=}" ;;
    --workspace=*)        WORKSPACE="${arg#*=}" ;;
    --tier=*)             TIERS="$TIERS ${arg#*=}" ;;
    --http-port=*)        HTTP_PORT="${arg#*=}" ;;
    --http-token=*)       HTTP_TOKEN="${arg#*=}" ;;
    --expected-plugins=*) EXPECTED_PLUGINS="${arg#*=}" ;;
    --cooldown=*)         COOLDOWN="${arg#*=}" ;;
    --on-fail=*)          ON_FAIL="${arg#*=}" ;;
    --alert-cmd=*)        ALERT_CMD="${arg#*=}" ;;
    --log-path=*)         LOG_PATH="${arg#*=}" ;;
    --llm-ping-interval=*) LLM_PING_INTERVAL="${arg#*=}" ;;
    --llm-ping-timeout-ms=*) LLM_PING_TIMEOUT_MS="${arg#*=}" ;;
    --stamp-file=*)       STAMP_FILE="${arg#*=}" ;;
    --help|-h)
      sed -n '2,42p' "$0"; exit 0 ;;
    *)
      echo "watcher.sh: unknown argument: $arg" >&2
      echo "Run with --help for usage." >&2
      exit 2 ;;
  esac
done

[[ -z "$TIERS" ]] && TIERS="1 2 3 4"
[[ -z "$LOG_PATH" ]] && LOG_PATH="/tmp/clawcode-watchdog-${SERVICE_LABEL:-default}.log"
STATE_FILE="/tmp/clawcode-watchdog-${SERVICE_LABEL:-default}.state"

# ---------------- Helpers ----------------

now_iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date +%s; }

log_line() {
  # Format: ISO8601 | status | tier_results | action
  printf '%s | %-5s | %-50s | %s\n' "$(now_iso)" "$1" "$2" "$3" >> "$LOG_PATH"
}

detect_os() {
  case "$(uname -s)" in
    Linux)  echo "linux" ;;
    Darwin) echo "mac" ;;
    *)      echo "unknown" ;;
  esac
}

# ---------------- Tier 1: service manager ----------------
check_tier1() {
  local os; os=$(detect_os)
  if [[ "$os" == "linux" ]]; then
    if systemctl --user is-active --quiet "$SERVICE_LABEL" 2>/dev/null; then
      echo "pass"
    else
      echo "FAIL(inactive)"
    fi
  elif [[ "$os" == "mac" ]]; then
    local out
    if out=$(launchctl print "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null); then
      if echo "$out" | grep -q "state = running"; then
        echo "pass"
      else
        echo "FAIL(not-running)"
      fi
    else
      echo "FAIL(not-loaded)"
    fi
  else
    echo "FAIL(unsupported-os)"
  fi
}

# ---------------- Tier 2: HTTP bridge /health ----------------
check_tier2() {
  local url="http://127.0.0.1:${HTTP_PORT}/health"
  local -a auth=()
  [[ -n "$HTTP_TOKEN" ]] && auth=(-H "Authorization: Bearer $HTTP_TOKEN")
  if curl -sf --max-time 5 "${auth[@]}" "$url" >/dev/null 2>&1; then
    echo "pass"
  else
    echo "FAIL(no-health)"
  fi
}

# ---------------- Tier 3: ClawCode MCP ping ----------------
check_tier3() {
  local url="http://127.0.0.1:${HTTP_PORT}/watchdog/mcp-ping"
  local -a auth=()
  [[ -n "$HTTP_TOKEN" ]] && auth=(-H "Authorization: Bearer $HTTP_TOKEN")
  local body
  if body=$(curl -sf --max-time 10 "${auth[@]}" "$url" 2>/dev/null); then
    if echo "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
      echo "pass"
    else
      echo "FAIL(bad-response)"
    fi
  else
    echo "FAIL(no-mcp-ping)"
  fi
}

# ---------------- Tier 4: scoped plugin subprocess check ----------------
get_service_main_pid() {
  local os; os=$(detect_os)
  if [[ "$os" == "linux" ]]; then
    systemctl --user show -p MainPID --value "$SERVICE_LABEL" 2>/dev/null
  elif [[ "$os" == "mac" ]]; then
    launchctl print "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null | \
      awk -F'= ' '/^[[:space:]]*pid[[:space:]]*=/{gsub(/[[:space:]]/,"",$2); print $2; exit}'
  fi
}

check_tier4() {
  if [[ -z "$EXPECTED_PLUGINS" ]]; then
    echo "skip"
    return
  fi

  local main_pid; main_pid=$(get_service_main_pid)
  if [[ -z "$main_pid" || "$main_pid" == "0" ]]; then
    echo "FAIL(no-main-pid)"
    return
  fi

  local os; os=$(detect_os)
  local child_cmdlines=""

  # Test hook: when set, skip the real /proc or ps introspection.
  # Undocumented on purpose — used by dev-tests/tier1n-watchdog-unit.sh.
  if [[ -n "${WATCHER_TEST_CHILD_CMDLINES:-}" ]]; then
    child_cmdlines="$WATCHER_TEST_CHILD_CMDLINES"
  elif [[ "$os" == "linux" ]]; then
    local pid
    for pid in $(pgrep -P "$main_pid" 2>/dev/null); do
      if [[ -r /proc/$pid/cmdline ]]; then
        child_cmdlines+=" $(tr '\0' ' ' </proc/$pid/cmdline)"
      fi
    done
  elif [[ "$os" == "mac" ]]; then
    child_cmdlines=$(ps -A -o ppid=,command= | awk -v p="$main_pid" '$1==p {$1=""; print}')
  fi

  local missing="" plugin
  IFS=',' read -ra plugins <<< "$EXPECTED_PLUGINS"
  for plugin in "${plugins[@]}"; do
    plugin=$(echo "$plugin" | tr -d '[:space:]')
    [[ -z "$plugin" ]] && continue
    if ! echo "$child_cmdlines" | grep -qi "$plugin"; then
      missing="${missing:+$missing,}no-$plugin"
    fi
  done

  if [[ -z "$missing" ]]; then
    echo "pass"
  else
    echo "FAIL($missing)"
  fi
}

# ---------------- Tier 5: LLM ping (end-to-end agent response) ----------------
# Only runs if LLM_PING_INTERVAL has elapsed since last call. Tracks last run
# in a separate state file so it's independent of the failure-cooldown.
TIER5_STATE_FILE="/tmp/clawcode-watchdog-${SERVICE_LABEL:-default}.tier5.state"

check_tier5() {
  # Interval gate: if we ran tier5 recently, skip this tick
  local last_tier5=0
  if [[ -f "$TIER5_STATE_FILE" ]]; then
    last_tier5=$(cat "$TIER5_STATE_FILE" 2>/dev/null || echo 0)
  fi
  local elapsed_tier5=$(( $(now_epoch) - last_tier5 ))
  if [[ "$LLM_PING_INTERVAL" -gt 0 && "$elapsed_tier5" -lt "$LLM_PING_INTERVAL" ]]; then
    local next_in=$(( LLM_PING_INTERVAL - elapsed_tier5 ))
    echo "skip(interval ${next_in}s)"
    return
  fi

  local url="http://127.0.0.1:${HTTP_PORT}/watchdog/llm-ping"
  local -a auth=()
  [[ -n "$HTTP_TOKEN" ]] && auth=(-H "Authorization: Bearer $HTTP_TOKEN")
  local max_wait=$(( (LLM_PING_TIMEOUT_MS / 1000) + 5 ))
  local body
  if body=$(curl -sf --max-time "$max_wait" -X POST \
    "${auth[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"timeout_ms\":${LLM_PING_TIMEOUT_MS}}" \
    "$url" 2>/dev/null); then
    now_epoch > "$TIER5_STATE_FILE"
    if echo "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
      echo "pass"
    else
      echo "FAIL(bad-response)"
    fi
  else
    # Don't update state file on failure — retry next tick
    echo "FAIL(no-llm-ping)"
  fi
}

# ---------------- Tier 6: version drift ----------------
# Detects the "git pull but service not restarted" failure mode: the service
# wrote its boot-time git HEAD to a stamp file at startup (via the
# ExecStartPre on Linux, the sh -c wrapper on macOS — see
# lib/service-generator.ts `versionStampPathExpr`). This check compares the
# stamped SHA against the current on-disk HEAD of $WORKSPACE and fails when
# they diverge, so the watcher's on-fail action (typically a service restart)
# can pick up the pulled code.
#
# Missing stamp, missing git, non-git workspace → "skip" (never FAIL) — the
# stamp is best-effort on the service side, so its absence is not a fault.
resolve_stamp_path() {
  if [[ -n "$STAMP_FILE" ]]; then
    echo "$STAMP_FILE"
    return
  fi
  [[ -z "$SLUG" ]] && return  # no slug → no derivable path
  local os; os=$(detect_os)
  if [[ "$os" == "mac" ]]; then
    local tmp="${TMPDIR%/}"
    [[ -z "$tmp" ]] && tmp="/tmp"
    echo "${tmp}/clawcode-${SLUG}.version"
  elif [[ "$os" == "linux" ]]; then
    local xdg="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    echo "${xdg}/clawcode-${SLUG}.version"
  fi
}

check_tier6() {
  local stamp_path; stamp_path=$(resolve_stamp_path)
  if [[ -z "$stamp_path" ]]; then
    echo "skip(no-slug)"
    return
  fi
  if [[ ! -r "$stamp_path" ]]; then
    echo "skip(no-stamp)"
    return
  fi
  if [[ -z "$WORKSPACE" || ! -d "$WORKSPACE/.git" ]]; then
    echo "skip(no-git-workspace)"
    return
  fi
  local stamped current
  stamped=$(tr -d '[:space:]' < "$stamp_path" 2>/dev/null || echo "")
  current=$(git -C "$WORKSPACE" rev-parse HEAD 2>/dev/null || echo "")
  if [[ -z "$stamped" || -z "$current" ]]; then
    echo "skip(empty-sha)"
    return
  fi
  if [[ "$stamped" == "$current" ]]; then
    echo "pass"
  else
    # Short SHAs in the message for readability, full SHAs are in the
    # log diagnostic appended by tail_service_log on FAIL.
    echo "FAIL(drift:${stamped:0:7}→${current:0:7})"
  fi
}

# ---------------- Cooldown ----------------
in_cooldown() {
  [[ -f "$STATE_FILE" ]] || return 1
  local last elapsed
  last=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
  elapsed=$(( $(now_epoch) - last ))
  [[ "$elapsed" -lt "$COOLDOWN" ]]
}

cooldown_remaining() {
  local last; last=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
  echo $(( COOLDOWN - ($(now_epoch) - last) ))
}

mark_restart() {
  now_epoch > "$STATE_FILE"
}

tail_service_log() {
  # Default service log path follows the convention in docs/service.md
  local svc_log="/tmp/${SERVICE_LABEL}.log"
  [[ -r "$svc_log" ]] || svc_log="/tmp/clawcode-${SERVICE_LABEL#clawcode-}.log"
  if [[ -r "$svc_log" ]]; then
    {
      echo "--- last 30 lines of $svc_log (post-FAIL diagnostic) ---"
      tail -n 30 "$svc_log"
      echo "--- end ---"
    } >> "$LOG_PATH"
  fi
}

# ---------------- Main ----------------

results=""
failed=""

for tier in $TIERS; do
  case "$tier" in
    1) r=$(check_tier1) ;;
    2) r=$(check_tier2) ;;
    3) r=$(check_tier3) ;;
    4) r=$(check_tier4) ;;
    5) r=$(check_tier5) ;;
    6) r=$(check_tier6) ;;
    *) r="skip" ;;
  esac
  results+=" tier${tier}:${r}"
  if [[ "$r" == FAIL* ]]; then
    failed="tier${tier}"
    break
  fi
done

results="${results## }"

if [[ -z "$failed" ]]; then
  log_line "OK" "$results" "-"
  exit 0
fi

if in_cooldown; then
  remaining=$(cooldown_remaining)
  log_line "SKIP" "$results" "cooldown (${remaining}s left)"
  exit 1
fi

action="no-action"
if [[ -n "$ON_FAIL" ]]; then
  action="restart"
  log_line "FAIL" "$results" "$action"
  tail_service_log
  bash -c "$ON_FAIL" >> "$LOG_PATH" 2>&1 || true
  mark_restart
  sleep 2
  post=$(check_tier1 2>/dev/null || echo "n/a")
  log_line "INFO" "tier1:$post" "post-restart verify"
else
  log_line "FAIL" "$results" "$action"
  mark_restart
fi

if [[ -n "$ALERT_CMD" ]]; then
  WATCHDOG_STATUS="FAIL" \
  WATCHDOG_RESULTS="$results" \
  WATCHDOG_ACTION="$action" \
  WATCHDOG_SERVICE="$SERVICE_LABEL" \
    bash -c "$ALERT_CMD" >> "$LOG_PATH" 2>&1 || true
fi

exit 1
