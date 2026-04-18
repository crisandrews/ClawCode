#!/usr/bin/env bash
# ClawCode Watchdog installer — macOS (launchd LaunchAgent).
#
# Same behavior as install-linux.sh but generates a user LaunchAgent plist
# with StartInterval. Does NOT touch the running ClawCode service.
#
# Flags:
#   --dry-run          Print what would be written; do not load plist.
#   --interval=<sec>   StartInterval (default: 300)
#   --label=<name>     Override service label

set -uo pipefail

RECIPE_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(pwd)"
DRY_RUN=0
INTERVAL="300"
LABEL_OVERRIDE=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --interval=*) INTERVAL="${arg#*=}" ;;
    --label=*)    LABEL_OVERRIDE="${arg#*=}" ;;
    --help|-h)    sed -n '2,15p' "$0"; exit 0 ;;
    *)            echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

derive_slug() {
  local name; name=$(basename "$WORKSPACE")
  echo "$name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//'
}

SLUG=$(derive_slug)
SERVICE_LABEL="${LABEL_OVERRIDE:-com.clawcode.${SLUG}}"
WATCHDOG_LABEL="com.clawcode.watchdog.${SLUG}"

HTTP_ENABLED="false"
HTTP_PORT="18790"
HTTP_TOKEN=""
if [[ -r "$WORKSPACE/agent-config.json" ]] && command -v jq >/dev/null 2>&1; then
  HTTP_ENABLED=$(jq -r '.http.enabled // false' "$WORKSPACE/agent-config.json" 2>/dev/null || echo "false")
  HTTP_PORT=$(jq -r '.http.port // 18790' "$WORKSPACE/agent-config.json" 2>/dev/null || echo "18790")
  HTTP_TOKEN=$(jq -r '.http.token // ""' "$WORKSPACE/agent-config.json" 2>/dev/null || echo "")
fi

EXPECTED_PLUGINS=""
PLUGIN_CACHE="$HOME/.claude/plugins/cache"
if [[ -d "$PLUGIN_CACHE" ]]; then
  for dir in "$PLUGIN_CACHE"/*/*/; do
    name=$(basename "$(dirname "$dir")")
    case "$name" in
      *telegram*)  EXPECTED_PLUGINS="${EXPECTED_PLUGINS:+$EXPECTED_PLUGINS,}telegram" ;;
      *whatsapp*)  EXPECTED_PLUGINS="${EXPECTED_PLUGINS:+$EXPECTED_PLUGINS,}whatsapp" ;;
      *discord*)   EXPECTED_PLUGINS="${EXPECTED_PLUGINS:+$EXPECTED_PLUGINS,}discord" ;;
      *slack*)     EXPECTED_PLUGINS="${EXPECTED_PLUGINS:+$EXPECTED_PLUGINS,}slack" ;;
    esac
  done
  EXPECTED_PLUGINS=$(echo "$EXPECTED_PLUGINS" | tr ',' '\n' | sort -u | paste -sd, -)
fi

ALERT_CMD=""
TELEGRAM_AUTH="$HOME/.claude/channels/telegram/.env"
if [[ -r "$TELEGRAM_AUTH" ]]; then
  echo "Found Telegram authentication at $TELEGRAM_AUTH."
  read -p "Enable Telegram alerts via alert-telegram.sh? [y/N] " yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    ALERT_CMD="$RECIPE_DIR/alert-telegram.sh"
  fi
fi

echo ""
echo "ClawCode Watchdog — macOS installer"
echo "-----------------------------------"
echo "Workspace:        $WORKSPACE"
echo "Service label:    $SERVICE_LABEL"
echo "Watchdog label:   $WATCHDOG_LABEL"
echo "Interval:         every ${INTERVAL}s (StartInterval)"
echo "HTTP bridge:      enabled=$HTTP_ENABLED port=$HTTP_PORT token=$([[ -n "$HTTP_TOKEN" ]] && echo 'set' || echo 'empty')"
echo "Expected plugins: ${EXPECTED_PLUGINS:-(none)}"
echo "Alert:            ${ALERT_CMD:-(none)}"
echo ""

if [[ "$HTTP_ENABLED" != "true" ]]; then
  cat <<'WARN'
NOTE: HTTP bridge is disabled in agent-config.json.
      Only Tier 1 (service manager) will run. Enable the bridge in
      agent-config.json and /mcp reload for Tier 2/3/4.
WARN
  echo ""
fi

PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/${WATCHDOG_LABEL}.plist"
LOG_FILE="/tmp/${WATCHDOG_LABEL}.log"

TIERS_ARGS=(--tier=1)
[[ "$HTTP_ENABLED" == "true" ]] && TIERS_ARGS+=(--tier=2 --tier=3)
[[ -n "$EXPECTED_PLUGINS" ]]    && TIERS_ARGS+=(--tier=4)
# Tier 6 (version drift) auto-enables for git workspaces. Detects the
# "git pull but service not restarted" case by diffing the boot-time
# stamp against the current HEAD. Silently skipped on non-git workspaces.
[[ -d "$WORKSPACE/.git" ]]      && TIERS_ARGS+=(--tier=6)

# Build the ProgramArguments array as plist XML fragments
ARGS_XML=""
ARGS_XML+="    <string>/bin/bash</string>\n"
ARGS_XML+="    <string>${RECIPE_DIR}/watcher.sh</string>\n"
ARGS_XML+="    <string>--service-label=${SERVICE_LABEL}</string>\n"
ARGS_XML+="    <string>--slug=${SLUG}</string>\n"
ARGS_XML+="    <string>--workspace=${WORKSPACE}</string>\n"
ARGS_XML+="    <string>--http-port=${HTTP_PORT}</string>\n"
[[ -n "$HTTP_TOKEN" ]]       && ARGS_XML+="    <string>--http-token=${HTTP_TOKEN}</string>\n"
[[ -n "$EXPECTED_PLUGINS" ]] && ARGS_XML+="    <string>--expected-plugins=${EXPECTED_PLUGINS}</string>\n"
for t in "${TIERS_ARGS[@]}"; do
  ARGS_XML+="    <string>${t}</string>\n"
done
ARGS_XML+="    <string>--cooldown=300</string>\n"
ARGS_XML+="    <string>--on-fail=launchctl kickstart -k gui/$(id -u)/${SERVICE_LABEL}</string>\n"
[[ -n "$ALERT_CMD" ]]        && ARGS_XML+="    <string>--alert-cmd=${ALERT_CMD}</string>\n"

PLIST_BODY=$(printf '<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>%s</string>
    <key>ProgramArguments</key>
    <array>
%b    </array>
    <key>StartInterval</key>
    <integer>%s</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>%s</string>
    <key>StandardErrorPath</key>
    <string>%s</string>
</dict>
</plist>
' "$WATCHDOG_LABEL" "$ARGS_XML" "$INTERVAL" "$LOG_FILE" "$LOG_FILE")

if [[ "$DRY_RUN" == "1" ]]; then
  echo "=== Would write $PLIST_FILE ==="
  echo "$PLIST_BODY"
  echo ""
  echo "(dry-run: not loading)"
  exit 0
fi

mkdir -p "$PLIST_DIR"
echo "$PLIST_BODY" > "$PLIST_FILE"

# Reload if already loaded; otherwise load
launchctl bootout "gui/$(id -u)/${WATCHDOG_LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
launchctl enable "gui/$(id -u)/${WATCHDOG_LABEL}" 2>/dev/null || true

echo ""
echo "Installed. LaunchAgent status:"
launchctl print "gui/$(id -u)/${WATCHDOG_LABEL}" 2>/dev/null | head -20 || true
echo ""
echo "Logs:      /tmp/clawcode-watchdog-${SERVICE_LABEL}.log (watchdog tick log)"
echo "Stdout:    ${LOG_FILE} (launchd stdout/err)"
echo "Uninstall: launchctl bootout gui/\$(id -u)/${WATCHDOG_LABEL} && rm ${PLIST_FILE}"
