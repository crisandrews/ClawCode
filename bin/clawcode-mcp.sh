#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export CLAWCODE_PLUGIN_ROOT="${CLAWCODE_PLUGIN_ROOT:-$PLUGIN_ROOT}"
export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$CLAWCODE_PLUGIN_ROOT}"

if [[ -z "${CLAWCODE_RUNTIME:-}" ]]; then
  if [[ -n "${CODEX_HOME:-}" ]]; then
    export CLAWCODE_RUNTIME="codex"
  else
    export CLAWCODE_RUNTIME="claude"
  fi
fi

if [[ -z "${CLAWCODE_WORKSPACE:-}" ]]; then
  if [[ -n "${CODEX_PROJECT_DIR:-}" ]]; then
    export CLAWCODE_WORKSPACE="$CODEX_PROJECT_DIR"
  elif [[ -n "${CODEX_WORKSPACE_ROOT:-}" ]]; then
    export CLAWCODE_WORKSPACE="$CODEX_WORKSPACE_ROOT"
  elif [[ -n "${CODEX_WORKSPACE:-}" ]]; then
    export CLAWCODE_WORKSPACE="$CODEX_WORKSPACE"
  elif [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
    export CLAWCODE_WORKSPACE="$CLAUDE_PROJECT_DIR"
  elif [[ -n "${OLDPWD:-}" && "$(cd "$OLDPWD" 2>/dev/null && pwd || true)" != "$PLUGIN_ROOT" ]]; then
    export CLAWCODE_WORKSPACE="$OLDPWD"
  elif [[ "$(pwd)" != "$PLUGIN_ROOT" ]]; then
    export CLAWCODE_WORKSPACE="$(pwd)"
  else
    export CLAWCODE_WORKSPACE="$PLUGIN_ROOT"
  fi
fi

export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$CLAWCODE_WORKSPACE}"

cd "$PLUGIN_ROOT"

if [[ ! -f node_modules/.bin/tsx ]]; then
  echo "[clawcode] Installing dependencies (first run)..." >&2
  npm install --prefix "$PLUGIN_ROOT" 2>&1 | tail -5 >&2
fi

if [[ ! -f node_modules/.bin/tsx ]]; then
  echo "[clawcode] ERROR: npm install failed. Check Node.js v18+ is installed: node --version" >&2
  echo "[clawcode] Try manually: npm install --prefix \"$PLUGIN_ROOT\"" >&2
  exit 1
fi

exec "$PLUGIN_ROOT/node_modules/.bin/tsx" "$PLUGIN_ROOT/server.ts"
