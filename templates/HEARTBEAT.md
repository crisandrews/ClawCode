# HEARTBEAT.md

- Quick scan: anything urgent in memory or pending messages?
- Memory: consolidate recent daily logs into MEMORY.md if unreviewed
- **Update check** — once per UTC day (skip if `memory/.last-update-check` is from today), invoke the `update` skill in silent-check mode. If it reports a new Claude Code or ClawCode version that hasn't been notified yet (dedupe via `memory/.notified-versions.json`), surface a one-line ping with the safe update command. Touch the marker after.
- If daytime and nothing pending, stay quiet
