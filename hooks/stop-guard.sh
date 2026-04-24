#!/usr/bin/env bash
# stop-guard.sh — Task Completion Guard (thin wrapper around lib/task-guard-cli.ts)
#
# Reads memory/.tasks/active.jsonl. If any task is still open, prints a
# Stop-hook JSON response that blocks termination and re-prompts the agent
# with the remaining acceptance criteria. A counter prevents infinite loops.
set -u
DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Forward stdin (Claude Code's hook payload) to the TS guard.
cd "$ROOT" 2>/dev/null || exit 0
exec env CLAWCODE_WORKSPACE="$DIR" \
  node_modules/.bin/tsx lib/task-guard-cli.ts 2>/dev/null
