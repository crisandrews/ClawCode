#!/usr/bin/env bash
# exec-gate-pretool.sh — PreToolUse hook for the execution gate.
#
# Architecture (Codex Step 2 pre-impl, Option E + pre-built CJS):
#
#   1. Hot path (mode=off everywhere AND tool is NOT a write tool):
#      bash + jq probe of agent-config.json + early exit. Target <15ms.
#      This is the 99% case for users who never opt into the gate.
#
#   2. Write-tool path (Write/Edit/MultiEdit/NotebookEdit):
#      ALWAYS invoke the CJS resolver. Protected-paths must fire
#      regardless of mode (mode=off users still get plugin-hooks /
#      ~/.ssh / agent-config protection).
#
#   3. Armed path (any channel's execGate.mode != "off"):
#      Invoke dist/exec-gate-resolver.cjs via node. Target <50ms.
#
# Exit codes:
#   - 0   = allow. Tool call proceeds.
#   - 2   = block. Stderr surfaces the reason to the user.
#
# Fail-soft: any unexpected condition (jq missing, node missing, CJS
# bundle missing, malformed stdin, resolver crash) → exit 0. Hooks MUST
# NEVER block legitimate work due to plugin internals. Same posture as
# hooks/cron-pretool.sh.

set -uo pipefail

# PATH prefix for ~/.local/bin so jq installed via Homebrew/asdf is
# visible under stripped launchd/systemd PATH (mirror of cron-pretool.sh).
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

WORKSPACE_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CONFIG_FILE="$WORKSPACE_ROOT/agent-config.json"
CJS_BUNDLE="$PLUGIN_ROOT/dist/exec-gate-resolver.cjs"

# Fail-soft preflight: required tools.
command -v jq >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0

# Read stdin payload (drained once — we'll re-feed it to node if needed).
PAYLOAD=$(cat 2>/dev/null || true)
[[ -z "$PAYLOAD" ]] && exit 0

# Extract tool_name. Empty → unrelated event, exit silently.
TOOL_NAME=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)
[[ -z "$TOOL_NAME" ]] && exit 0

# Write-tool short-circuit: ALWAYS invoke the resolver because the
# always-on protected-paths check must fire regardless of mode.
case "$TOOL_NAME" in
  Write|Edit|MultiEdit|NotebookEdit)
    INVOKE_RESOLVER=1
    ;;
  *)
    INVOKE_RESOLVER=0
    ;;
esac

# If we don't already need the resolver, check whether ANY scope channel
# has a non-off execGate. File-absent is a zero-cost skip — loadConfig
# returns defaults (mode=off everywhere) when agent-config.json is
# missing.
#
# Codex Step 2 post-impl round-1 FAIL B: the probe MUST be conservative.
# The previous version counted only entries where `.execGate.mode` was
# the literal string `"shadow"` or `"enforce"`. That misses every
# malformed shape: `execGate: null`, `execGate: "string"`, `execGate: []`,
# `execGate: {mode: "weird"}`, etc. The TS coercion treats all of those
# as fail-closed (enforce + denylist). The shell probe must agree, or a
# malformed config silently re-opens the gate.
#
# Classification rule (matches `coerceExecGateConfig` in
# lib/scope/exec-gate.ts):
#   - channel-key value not an object         → off (channel itself ill-shaped, skip)
#   - .execGate absent                         → off
#   - .execGate == null                        → ARMED (enforce fallback)
#   - .execGate is not an object               → ARMED (enforce fallback)
#   - .execGate has no .mode field             → off (TS coerces undefined→off)
#   - .execGate.mode == "off"                  → off
#   - .execGate.mode anything else             → ARMED
#
# Plus: if jq itself errors (malformed JSON, missing binary), we fail
# CLOSED and invoke the resolver. The previous `|| echo "0"` swallowed
# jq errors as "no armed channels"; that bypass is now removed.
if [[ $INVOKE_RESOLVER -eq 0 ]]; then
  if [[ ! -f "$CONFIG_FILE" ]]; then
    exit 0
  fi
  # Codex round-2 HIGH 1 closure: when execGate.mode == "off" but the
  # block has malformed sub-fields (policy, tools, lookbackMs), the TS
  # coercion in `coerceExecGateConfig` escalates the whole block to
  # enforce (fail-closed). The jq probe must agree — checking ONLY the
  # mode field would let `{mode:"off", policy:"weird"}` exit the hot
  # path while the resolver would have armed. Defensive rule: a strict
  # off requires mode=="off" AND every other present sub-field is the
  # exact type the coercion accepts. Anything else → armed.
  # Also: a non-object `scope.<channel>` value is a configuration error
  # too (Codex HIGH 2 mirror), but the TS entry script catches that
  # case post-merge. The jq fast path stays "off" for those because
  # the resolver still has to be invoked for protected-paths-write
  # tools anyway, and for non-write tools the entry's malformed-
  # channel synthesis is what surfaces the gate.
  ARMED_COUNT=$(jq -r '
    [
      (.scope // {}) | to_entries[] |
      .value as $v |
      if $v == null or ($v | type) != "object" then
        # Codex round-2 HIGH 2 (jq side): non-object channel values
        # silently dropped by mergeScopeConfig — they MUST route to the
        # resolver so the entry script can synthesize an unresolved
        # sentinel and the gate fires. Without this, the bash hot path
        # exits 0 before the entry has any chance to inspect the raw
        # JSON.
        "armed"
      elif ($v | has("execGate") | not) then
        "off"
      elif $v.execGate == null then
        "armed"
      elif ($v.execGate | type) != "object" then
        "armed"
      elif ($v.execGate | has("mode") | not) then
        "off"
      elif $v.execGate.mode != "off" then
        "armed"
      else
        # mode == "off". Check sub-field validity. Any invalid sub-field
        # escalates to armed (matches TS coerce).
        ($v.execGate | (
          (if has("policy") then
            (if (.policy == "denylist" or .policy == "allowlist") then "ok" else "bad" end)
           else "ok" end)
          + "/" +
          (if has("tools") then
            (if (.tools | type) == "array" and ((.tools | all(type == "string"))) then "ok" else "bad" end)
           else "ok" end)
          + "/" +
          (if has("lookbackMs") then
            # Codex round-3 LOW 2: mirror Number.isFinite. jq type-check
            # accepts non-finite literals depending on encoding. The
            # upper bound below tolerates any realistic lookback (years)
            # while rejecting Infinity and absurd literals.
            (if (.lookbackMs | type) == "number"
                and .lookbackMs > 0
                and .lookbackMs < 9000000000000
              then "ok" else "bad" end)
           else "ok" end)
        )) as $check |
        if ($check | contains("bad")) then "armed" else "off" end
      end
    ] | map(select(. == "armed")) | length
  ' "$CONFIG_FILE" 2>/dev/null)
  # Fail-closed: any jq error → empty string or non-numeric → invoke CJS.
  if [[ ! "$ARMED_COUNT" =~ ^[0-9]+$ ]]; then
    INVOKE_RESOLVER=1
  elif [[ "$ARMED_COUNT" -eq 0 ]]; then
    exit 0
  else
    INVOKE_RESOLVER=1
  fi
fi

# At this point INVOKE_RESOLVER=1. Spawn the CJS bundle and let it
# decide. If the bundle is missing (uncompiled checkout, partial install)
# we fail-soft — never block.
if [[ ! -f "$CJS_BUNDLE" ]]; then
  exit 0
fi

# Forward the payload via stdin. Use exec so the hook's exit code is
# whatever the bundle returns.
printf '%s' "$PAYLOAD" | exec node "$CJS_BUNDLE"
