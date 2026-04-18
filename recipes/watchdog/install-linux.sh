#!/usr/bin/env bash
# ClawCode Watchdog installer — Linux (systemd --user).
#
# Auto-detects everything from the current workspace + agent-config.json,
# then generates a systemd user timer that runs watcher.sh every 5 minutes.
# Asks at most one question (alert channel, only if ambiguous).
#
# This script does NOT touch the running ClawCode service. The service can
# stay active while you install.
#
# Flags:
#   --dry-run          Print what would be written; do not enable timer.
#   --interval=<sec>   Schedule interval (default: 300)
#   --label=<name>     Override service label (default: derived from workspace)

set -uo pipefail

RECIPE_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(pwd)"
DRY_RUN=0
INTERVAL="300"
LABEL_OVERRIDE=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)     DRY_RUN=1 ;;
    --interval=*)  INTERVAL="${arg#*=}" ;;
    --label=*)     LABEL_OVERRIDE="${arg#*=}" ;;
    --help|-h)     sed -n '2,20p' "$0"; exit 0 ;;
    *)             echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ------------ Auto-detection ------------

derive_slug() {
  local name; name=$(basename "$WORKSPACE")
  echo "$name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//'
}

SLUG=$(derive_slug)
SERVICE_LABEL="${LABEL_OVERRIDE:-clawcode-${SLUG}.service}"
WATCHDOG_LABEL="clawcode-watchdog-${SLUG}"

# HTTP config from agent-config.json (fall back to defaults)
HTTP_ENABLED="false"
HTTP_PORT="18790"
HTTP_TOKEN=""
if [[ -r "$WORKSPACE/agent-config.json" ]] && command -v jq >/dev/null 2>&1; then
  HTTP_ENABLED=$(jq -r '.http.enabled // false' "$WORKSPACE/agent-config.json" 2>/dev/null || echo "false")
  HTTP_PORT=$(jq -r '.http.port // 18790' "$WORKSPACE/agent-config.json" 2>/dev/null || echo "18790")
  HTTP_TOKEN=$(jq -r '.http.token // ""' "$WORKSPACE/agent-config.json" 2>/dev/null || echo "")
fi

# Installed channel plugins (for --expected-plugins)
EXPECTED_PLUGINS=""
PLUGIN_CACHE="$HOME/.claude/plugins/cache"
if [[ -d "$PLUGIN_CACHE" ]]; then
  for dir in "$PLUGIN_CACHE"/*/*/; do
    name=$(basename "$(dirname "$dir")")
    # Recognize channel plugin names
    case "$name" in
      *telegram*)  EXPECTED_PLUGINS="${EXPECTED_PLUGINS:+$EXPECTED_PLUGINS,}telegram" ;;
      *whatsapp*)  EXPECTED_PLUGINS="${EXPECTED_PLUGINS:+$EXPECTED_PLUGINS,}whatsapp" ;;
      *discord*)   EXPECTED_PLUGINS="${EXPECTED_PLUGINS:+$EXPECTED_PLUGINS,}discord" ;;
      *slack*)     EXPECTED_PLUGINS="${EXPECTED_PLUGINS:+$EXPECTED_PLUGINS,}slack" ;;
    esac
  done
  # Dedupe
  EXPECTED_PLUGINS=$(echo "$EXPECTED_PLUGINS" | tr ',' '\n' | sort -u | paste -sd, -)
fi

# Alert script selection
ALERT_CMD=""
TELEGRAM_AUTH="$HOME/.claude/channels/telegram/.env"
if [[ -r "$TELEGRAM_AUTH" ]]; then
  echo "Found Telegram authentication at $TELEGRAM_AUTH."
  read -p "Enable Telegram alerts via alert-telegram.sh? [y/N] " yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    ALERT_CMD="$RECIPE_DIR/alert-telegram.sh"
  fi
fi

# ------------ Summary ------------

echo ""
echo "ClawCode Watchdog — Linux installer"
echo "-----------------------------------"
echo "Workspace:        $WORKSPACE"
echo "Service label:    $SERVICE_LABEL"
echo "Watchdog label:   $WATCHDOG_LABEL"
echo "Interval:         every ${INTERVAL}s"
echo "HTTP bridge:      enabled=$HTTP_ENABLED port=$HTTP_PORT token=$([[ -n "$HTTP_TOKEN" ]] && echo 'set' || echo 'empty')"
echo "Expected plugins: ${EXPECTED_PLUGINS:-(none)}"
echo "Alert:            ${ALERT_CMD:-(none)}"
echo ""

if [[ "$HTTP_ENABLED" != "true" ]]; then
  cat <<'WARN'
NOTE: HTTP bridge is disabled in agent-config.json.
      Only Tier 1 (service manager) will run. Tier 2 (/health), Tier 3
      (/watchdog/mcp-ping), and Tier 4 (plugin subprocess via PID) require
      the bridge. Enable it in agent-config.json and /mcp reload if you
      want deeper checks.
WARN
  echo ""
fi

# ------------ Build unit files ------------

SYSTEMD_DIR="$HOME/.config/systemd/user"
TIMER_FILE="$SYSTEMD_DIR/${WATCHDOG_LABEL}.timer"
SERVICE_FILE="$SYSTEMD_DIR/${WATCHDOG_LABEL}.service"

TIERS_FLAGS="--tier=1"
[[ "$HTTP_ENABLED" == "true" ]] && TIERS_FLAGS="$TIERS_FLAGS --tier=2 --tier=3"
[[ -n "$EXPECTED_PLUGINS" ]]    && TIERS_FLAGS="$TIERS_FLAGS --tier=4"
# Tier 6 (version drift) auto-enables for git workspaces. Detects the
# "git pull but service not restarted" case by diffing the boot-time
# stamp against the current HEAD. Silently skipped on non-git workspaces.
[[ -d "$WORKSPACE/.git" ]] && TIERS_FLAGS="$TIERS_FLAGS --tier=6"

TOKEN_FLAG=""
[[ -n "$HTTP_TOKEN" ]] && TOKEN_FLAG=" --http-token=$HTTP_TOKEN"

PLUGINS_FLAG=""
[[ -n "$EXPECTED_PLUGINS" ]] && PLUGINS_FLAG=" --expected-plugins=$EXPECTED_PLUGINS"

ALERT_FLAG=""
[[ -n "$ALERT_CMD" ]] && ALERT_FLAG=" --alert-cmd=$ALERT_CMD"

SERVICE_BODY=$(cat <<EOF
[Unit]
Description=ClawCode Watchdog for ${SERVICE_LABEL}
After=network.target

[Service]
Type=oneshot
ExecStart=/bin/bash ${RECIPE_DIR}/watcher.sh \\
  --service-label=${SERVICE_LABEL} \\
  --slug=${SLUG} \\
  --workspace=${WORKSPACE} \\
  --http-port=${HTTP_PORT}${TOKEN_FLAG}${PLUGINS_FLAG} \\
  ${TIERS_FLAGS} \\
  --cooldown=300 \\
  --on-fail='systemctl --user restart ${SERVICE_LABEL}'${ALERT_FLAG}
EOF
)

TIMER_BODY=$(cat <<EOF
[Unit]
Description=ClawCode Watchdog timer for ${SERVICE_LABEL}

[Timer]
OnBootSec=1min
OnUnitActiveSec=${INTERVAL}s
Unit=${WATCHDOG_LABEL}.service

[Install]
WantedBy=timers.target
EOF
)

if [[ "$DRY_RUN" == "1" ]]; then
  echo "=== Would write $SERVICE_FILE ==="
  echo "$SERVICE_BODY"
  echo ""
  echo "=== Would write $TIMER_FILE ==="
  echo "$TIMER_BODY"
  echo ""
  echo "(dry-run: not enabling anything)"
  exit 0
fi

mkdir -p "$SYSTEMD_DIR"
echo "$SERVICE_BODY" > "$SERVICE_FILE"
echo "$TIMER_BODY"   > "$TIMER_FILE"

systemctl --user daemon-reload
systemctl --user enable --now "${WATCHDOG_LABEL}.timer"

echo ""
echo "Installed. Timer status:"
systemctl --user list-timers "${WATCHDOG_LABEL}.timer" --no-pager || true
echo ""
echo "Logs: /tmp/clawcode-watchdog-${SERVICE_LABEL}.log"
echo "Uninstall: systemctl --user disable --now ${WATCHDOG_LABEL}.timer && rm ${TIMER_FILE} ${SERVICE_FILE}"
echo ""
echo "Tip: if this host runs headless, enable 'loginctl enable-linger \$USER' so the user"
echo "systemd instance keeps running after you log out."
