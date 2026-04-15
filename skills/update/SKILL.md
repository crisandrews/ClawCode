---
name: update
description: Check for new versions of Claude Code and ClawCode, and print safe update commands. Triggers on /agent:update, /update, "check for updates", "are there updates", "buscar actualizaciones".
user-invocable: true
---

# /agent:update — Check for new versions

Detect whether new versions of Claude Code (`@anthropic-ai/claude-code`) or ClawCode (this repo) are available, and surface the safe update procedure for each. Designed for users running ClawCode as a long-running daemon, where Claude Code's in-process auto-updater is disabled (see `lib/service-generator.ts` — `Environment=DISABLE_AUTOUPDATER=1`) and updates have to be applied explicitly.

## When to use

- User asks `/agent:update`, `/update`, "check for updates", "are there updates", etc.
- Heartbeat skill calls in silent-check mode (see `templates/HEARTBEAT.md`).
- Before applying any change to the running service — knowing the upstream version helps decide whether to bundle with an update.

## Steps

1. **Detect current versions.** Run all three in parallel (independent reads):

   ```bash
   # Claude Code installed binary
   CC_INSTALLED=$(claude --version 2>/dev/null | awk '{print $1}')

   # ClawCode local repo HEAD
   PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(pwd)/ClawCode}"
   CW_LOCAL=$(git -C "$PLUGIN_ROOT" rev-parse --short HEAD 2>/dev/null)
   CW_LOCAL_TAG=$(git -C "$PLUGIN_ROOT" describe --tags --abbrev=0 2>/dev/null || echo "no-tag")
   ```

2. **Detect available versions.** Network calls — be tolerant of failures (no network, npm flake, GitHub down):

   ```bash
   # Claude Code latest on npm
   CC_LATEST=$(npm view @anthropic-ai/claude-code version 2>/dev/null)

   # ClawCode latest tag and HEAD on upstream
   git -C "$PLUGIN_ROOT" fetch upstream --tags 2>/dev/null
   CW_UPSTREAM_HEAD=$(git -C "$PLUGIN_ROOT" rev-parse --short upstream/main 2>/dev/null)
   CW_UPSTREAM_TAG=$(git -C "$PLUGIN_ROOT" describe --tags --abbrev=0 upstream/main 2>/dev/null || echo "no-tag")
   ```

   If any value is empty, treat that side as "unknown" rather than failing the whole check.

3. **Compare and decide.** Two boolean signals: `CC_UPDATE_AVAILABLE` and `CW_UPDATE_AVAILABLE`.

   - Claude Code: `CC_UPDATE_AVAILABLE=1` if `CC_INSTALLED` and `CC_LATEST` are both set and not equal.
   - ClawCode: `CW_UPDATE_AVAILABLE=1` if `CW_LOCAL` and `CW_UPSTREAM_HEAD` are both set and `git merge-base --is-ancestor upstream/main HEAD` is **false** — i.e. upstream has commits the local repo doesn't yet have.

4. **Surface the result.** Always show a status block. If updates are available, append the safe procedure for each.

   ```
   📦 *Update check*

   Claude Code:    <CC_INSTALLED> → <CC_LATEST>   <✅ current | ⬆️ update available | ⚠️ unknown>
   ClawCode:       <CW_LOCAL_TAG>+<CW_LOCAL> → <CW_UPSTREAM_TAG>+<CW_UPSTREAM_HEAD>   <✅ current | ⬆️ update available | ⚠️ unknown>
   ```

   When at least one update is available, append:

   ```
   To apply (in a root shell on the host running the service):

     npm install -g @anthropic-ai/claude-code            # if Claude Code update
     git -C <plugin-root> pull upstream main             # if ClawCode update
     systemctl --user restart clawcode-<slug>.service    # always — picks up both
   ```

   Substitute `<plugin-root>` and `<slug>` from the actual service install (read from `~/.config/systemd/user/clawcode-*.service` if present, otherwise leave the placeholders).

5. **On a messaging channel:** trim the output for mobile. Use the channel-appropriate `reply` tool (e.g. `mcp__plugin_telegram_telegram__reply`). Don't include long bash blocks — instead one short line per actionable update, and offer "want the full commands?" as a follow-up.

## Permission notes

- The `claude` user typically **cannot** run `npm install -g` (`/usr/local/lib/node_modules/` is root-owned). The skill detects + reports — it does **not** execute the install. The user (or their root-capable operator) runs the printed commands themselves.
- `git pull` works as long as the user owns the plugin repo directory. ClawCode updates can be applied without elevation.
- `systemctl --user restart` requires no root for user-mode services, but **kills the running session**. Warn before suggesting it during an active conversation.

## Silent-check mode (called by heartbeat)

When invoked from the heartbeat skill, the goal is *not* to spam the user every 30 minutes. Use a memory-backed dedupe so each new version is announced exactly once:

```bash
NOTIFIED_FILE="$AGENT_ROOT/memory/.notified-versions.json"
# Read the last-notified version for each component.
LAST_CC=$(jq -r '.["claude-code"] // ""' "$NOTIFIED_FILE" 2>/dev/null)
LAST_CW=$(jq -r '.clawcode // ""' "$NOTIFIED_FILE" 2>/dev/null)

# Only notify when the available version differs from BOTH the installed AND the last-notified.
if [[ -n "$CC_LATEST" && "$CC_LATEST" != "$CC_INSTALLED" && "$CC_LATEST" != "$LAST_CC" ]]; then
  # ping user, then record the new last-notified
  jq --arg v "$CC_LATEST" '.["claude-code"] = $v' "$NOTIFIED_FILE" > "$NOTIFIED_FILE.tmp" \
    && mv "$NOTIFIED_FILE.tmp" "$NOTIFIED_FILE"
fi
# Same shape for ClawCode.
```

Initialize the file as `{}` if it doesn't exist. The dedupe survives restarts because it's in `memory/`, not `/tmp`.

Also gate on a coarser per-day check via `memory/.last-update-check` — heartbeat fires every 30 min but the network round-trip to npm + GitHub doesn't need to happen that often. Skip the network calls entirely if the marker's mtime is < 24h old; just compare against the cached state.

## Notes

- This skill never *applies* updates. It only detects, reports, and tells the user the safe command. That's deliberate — a daemonized agent that auto-applies updates to its own runtime is exactly what we just disabled.
- If the plugin repo isn't a git checkout (rare — installed via plugin manager only), skip the ClawCode side gracefully and just check Claude Code.
- Channel-specific formatting: WhatsApp uses `*bold*`; Telegram supports `**bold**` or HTML; CLI is plain markdown.
