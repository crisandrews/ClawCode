#!/usr/bin/env bash
# scope-trust-legacy-warn.sh — SessionStart hook for ClawCode.
#
# Surfaces a ONE-LINE stderr advisory the first time a session starts if
# the user has 1.6-era flat-layout trust files at
#   ~/.claude/agent/scope-trust/<channel>-{owner,exec}
# and the workspace-bound 1.7 layout (under <fingerprint>/) is NOT yet
# established. After 1.7's hard cutover those flat files no longer
# unlock, so users who don't run `/agent:scope wizard` per workspace
# silently lose trust.
#
# Failure-mode contract:
#   - NEVER blocks session start. Always exits 0.
#   - SILENT when no legacy files present (clean post-1.7 install).
#   - SILENT when workspace fingerprint can't be computed (CLAUDE_PLUGIN_ROOT
#     missing, bridge script missing, tsx unavailable) — these are config
#     errors, not user-actionable warnings, and would just create alarm.
#   - HONORS a workspace-scoped dismissal marker (see DISMISS_PATH below).
#
# Codex Phase 8 Step 2 pre-impl Q5 + Q10:
#   - Dismissal is keyed by workspace fingerprint, NOT global, so dismissing
#     in workspace A doesn't silence the advisory in workspace B.
#   - Bridge script computes the fingerprint via the same TS helper the
#     resolver uses — no Bash-side hash reimplementation.

set -uo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
WORKSPACE_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
TRUST_BASE="${CLAW_SCOPE_TRUST_DIR:-$HOME/.claude/agent/scope-trust}"

# Fail-soft: no plugin root → silent.
if [ -z "$PLUGIN_ROOT" ]; then
  exit 0
fi

# Trust dir absent → clean install, nothing to warn.
if [ ! -d "$TRUST_BASE" ]; then
  exit 0
fi

# Compute fingerprint via the bridge script. Use `node ...tsx/dist/cli.mjs`
# (not `npx tsx` — that fails when invoked from arbitrary cwd; Codex Phase 8
# round-1 HIGH #2). Capture stdout only; redirect stderr away so a transient
# bridge error doesn't leak into the user's terminal.
BRIDGE="$PLUGIN_ROOT/scripts/print-workspace-fingerprint.mjs"
TSX_CLI="$PLUGIN_ROOT/node_modules/tsx/dist/cli.mjs"
if [ ! -f "$BRIDGE" ] || [ ! -f "$TSX_CLI" ]; then
  exit 0
fi
TS_HASH=$(node "$TSX_CLI" "$BRIDGE" "$WORKSPACE_ROOT" 2>/dev/null) || exit 0
# Validate: exactly 32 hex chars. Anything else = corrupt bridge output.
if ! [[ "$TS_HASH" =~ ^[0-9a-f]{32}$ ]]; then
  exit 0
fi

# Workspace-scoped dismissal marker — Codex Q10. Presence is the signal.
# The doctor row applies the full mode/uid predicate; this hook trusts the
# user's intent if the file exists (and the parent fingerprint subdir is
# under user control anyway).
DISMISS_PATH="$TRUST_BASE/$TS_HASH/.scope-trust-legacy-dismissed"
if [ -f "$DISMISS_PATH" ]; then
  exit 0
fi

# Walk direct children of the trust base looking for flat-layout 1.6 markers.
# Skip dirs (1.7 fingerprint subdirs), follow regular files only.
# Codex Phase 8 Step 2 post-impl LOW #1: mirror the doctor's `legacyGlobalTrustExists`
# predicate so stale 0o644 leftovers or wrong-uid files don't trigger noise that
# the doctor would correctly suppress. Match on: regular file (no symlink) +
# owner UID matches process UID + mode `& 0o077 === 0`.
PROC_UID=$(id -u 2>/dev/null || echo "")
detected=()
for entry in "$TRUST_BASE"/*; do
  [ -e "$entry" ] || continue  # glob expanded to literal `*` (empty dir)
  [ -f "$entry" ] || continue  # not a regular file (could be dir/symlink/fifo)
  # Reject symlinks even if they point at regular files — same posture as
  # the trust reader's O_NOFOLLOW.
  [ -L "$entry" ] && continue
  name="$(basename "$entry")"
  # Match `<channel>-owner` or `<channel>-exec` exactly (lowercase a-z).
  if ! [[ "$name" =~ ^[a-z]+-(owner|exec)$ ]]; then
    continue
  fi
  # Mode bits & 0o077 must be zero (no group/world bits).
  mode_octal=$(stat -f "%Lp" "$entry" 2>/dev/null || stat -c "%a" "$entry" 2>/dev/null || echo "")
  if [ -z "$mode_octal" ]; then continue; fi
  # `stat` may print 600 or 0600; normalize.
  mode_norm="${mode_octal#0}"
  # Bash arithmetic: only test the low 7 bits.
  if (( 0$mode_norm & 0077 )); then continue; fi
  # UID match (skip if `id -u` failed).
  if [ -n "$PROC_UID" ]; then
    file_uid=$(stat -f "%u" "$entry" 2>/dev/null || stat -c "%u" "$entry" 2>/dev/null || echo "")
    if [ -n "$file_uid" ] && [ "$file_uid" != "$PROC_UID" ]; then
      continue
    fi
  fi
  detected+=("$name")
done

if [ "${#detected[@]}" -eq 0 ]; then
  exit 0
fi

# One-line stderr advisory. The exact recovery action lives in the doctor
# row (`/agent:doctor`) so users can copy-paste the rm command from there
# after they've re-granted.
joined="${detected[*]}"
DISMISS_PARENT=$(dirname "$DISMISS_PATH")
echo "[clawcode] Legacy 1.6 scope-trust file(s) detected ($joined). After upgrading to 1.7+, trust is per-workspace — run \`/agent:scope wizard\` in this workspace to re-grant. Run \`/agent:doctor\` for details + cleanup command. Dismiss for this workspace: mkdir -p \"$DISMISS_PARENT\" && chmod 700 \"$DISMISS_PARENT\" && touch \"$DISMISS_PATH\" && chmod 600 \"$DISMISS_PATH\"." >&2

exit 0
