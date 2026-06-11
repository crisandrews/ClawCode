# Changelog

## [Unreleased]

### Fixes

- Hooks/scope-trust-legacy-warn: on GNU/Linux the legacy-trust advisory crashed with `File: unbound variable` at every SessionStart for users with 1.6-era trust files, instead of printing its one-line warning. Root cause: GNU `stat -f` means `--file-system` (not "format" like BSD), so the probe captured a multi-line filesystem block that leaked into bash arithmetic under `set -u`. Both `stat` probes now go GNU-first (`-c`) with BSD fallback (`-f`) and are value-checked before use — the same convention `bin/cron-from.sh` adopted in 1.7.5. macOS behavior unchanged.

## [1.7.6] — 2026-06-11

### Why these changes matter

Issue #32 (reported from the field): after a session reset, the agent-executed reconcile envelope re-created only 13 of 40 registry crons, and the other 27 stayed silently dead for 9 days — registry said `alive`, the harness fired nothing, and no alert existed anywhere. The completion summary was computed by the agent itself and persisted nowhere, `lastSeenAlive` only moved when an entry was re-created, and a long-running session never re-checked. This round makes the completion check mechanical, persists it, surfaces it (doctor + envelope + list), and adds in-session self-healing via the heartbeat. Design and amendments adversarially reviewed (gpt-5.5 xhigh, consensus).

### Fixes

- Skills/crons (writeback): new `audit` subcommand — the mechanical reconcile completion check. Takes the FULL `CronList` output on stdin (STRICT: blank input or any unparseable non-empty line is format drift, exit 4, nothing persisted — a broken pipe can never mark every reminder orphaned), refreshes `lastSeenAlive` for every confirmed-alive entry (not just re-created ones), safely relinks an orphaned entry when exactly one unclaimed live cron matches its (cron, prompt, recurring) triple — the "CronCreate succeeded but set-alive never ran" partial-failure case — and classifies the rest as `orphan` (no live match; safe to auto-recreate) or `blocked` (ambiguous live duplicates; never auto-recreated, and adoption is skipped while any exist, so a partial success can never be tripled). Persists a top-level `.audit` summary (`at/expected/alive/orphaned/relinked/blocked/unknown/orphanKeys/blockedKeys`) in the registry for offline readers. Output: `orphan key=…` / `relinked key=…` / `blocked key=…` lines plus `audit: alive=K/N orphaned=X relinked=L blocked=B unknown=M`.
- Hooks/reconcile-crons: the envelope is now audit-first and mechanically verified — CronList → audit (relink survivors before any create) → re-create only the reported orphan keys, continuing past individual failures → re-audit → one bounded retry → adopt-unknown only when the audit saw unknown ids → final audit → the completion line quotes the audit summary verbatim (no agent-computed counts), and remaining orphans are reported to the user in plain language. The envelope is declared a SINGLE unit of work: an interleaved chat reply must resume the pending steps in the same turn (hardens the 2026-06-09 mid-reconcile stall).
- Skills/heartbeat: new always-on cron-health step that runs even outside active hours — `prune-expired` first (so repair can never resurrect fired one-shots), then CronList → audit, then re-create any orphans with the `.reconciling` marker held only for the duration of the repair. This is what self-heals a long-running session: orphaned reminders now wait at most one heartbeat (30 min), not days for the next SessionStart. Notifications are throttled (only when the same keys stay orphaned across two consecutive beats).
- Skills/crons (writeback): `set-alive` (and `audit`) now refresh the `.reconciling` marker only while it is still fresh (<10 min) — a stale marker left behind by a crashed reconcile is no longer silently resurrected, which would have re-opened the CronCreate stamp bypass and suppressed ad-hoc capture for whoever wrote next.
- Lib/doctor: the cron-registry check reads the persisted `.audit` — warns with the orphaned and/or blocked keys (and the audit timestamp) whenever the last audit recorded either, reports `last audit … K/N alive` when clean, and `not yet audited` before the first audit. Doctor stays offline; it never calls CronList itself. The `/agent:doctor` skill now refreshes the audit (CronList → `writeback.sh audit`) BEFORE printing the card, so the offline card and the live cron section can't contradict each other.
- Skills/crons (skill): LIST now runs `prune-expired` and pipes the CronList output it already fetched through `audit` (free `lastSeenAlive` refresh; never auto-repairs — orphans render as ⚠️ with a `/agent:crons reconcile` suggestion). The manual RECONCILE flow mirrors the envelope's repair loop and now touches/removes the `.reconciling` marker explicitly instead of relying on the pretool rejection hint to teach it. Skills/doctor: the CronList call now feeds `audit` first so the rendered cron section and the offline `.audit` state can't contradict each other.
- Docs/crons: corrected the two-sessions failure-mode row — the writeback lock serializes individual registry writes only; it never made the second session skip its reconcile (that remains a known limitation; a registry session-lease is the planned fix).

### Changes

- CI: new `.github/workflows/ci.yml` — validates the plugin on every push/PR across ubuntu + macos (Node 20): dependency install, jq availability, and shell-entrypoint parse checks for the hooks, `writeback.sh`, and `cron-from.sh`.

### Compatibility

- Registry schema change is additive only (top-level `audit` object, absent until the first audit runs); `version` stays 1, the writeback shape validation (`version == 1 and has("entries")`) is unaffected, and existing registries work untouched. The only behavior change to existing subcommands is the stale-marker guard in `set-alive`, which narrows a bypass window — it never widens anything.

## [1.7.5] — 2026-06-09

### Why this release matters

Two structural fixes for the SessionStart cron reconcile, both hit in the field on 2026-06-09. First, a reconcile interleaved with live channel chat could outlive the 10-minute `.reconciling` marker: the pretool gate then blocked the remaining recreations with a misleading stale-stamp error and the agent had to figure out the recovery by reading hook source. Second, dated one-shot reminders ("remind me tonight at 23:15") were never retired after firing: every reconcile resurrected them verbatim, scheduled for the same date a year later — and annually thereafter. Both fixes follow the 2026-06-09 adversarial design review: expiry is decided only from explicit creation-time metadata, never from date heuristics. Pairs with claude-whatsapp 1.21.0 (single-instance auto-takeover); the channels skill wording is updated accordingly.

### Fixes

- Skills/crons (writeback): `set-alive` now refreshes the `.reconciling` marker mtime (only when the marker already exists), so the hooks' 10-minute bypass window slides as long as the reconcile keeps making real progress. Long reconciles interleaved with chat no longer get blocked mid-flight.
- Hooks/cron-posttool: ad-hoc capture no longer coerces `recurring: false` to `true` (jq's `//` swallows boolean false). Without this, every captured one-shot was stored as recurring and stayed invisible to `prune-expired` — the resurrection bug would have survived its own fix on the primary path.
- Hooks/cron-pretool: every rejection (missing stamp, stale stamp, malformed stamp, cron mismatch) now appends a mid-reconcile recovery hint — re-touch the workspace's `memory/.reconciling` (absolute path included in the message) and retry — instead of only pointing at `cron-from.sh`, which is the wrong fix while replaying registry crons.
- Bin/cron-from: BSD/GNU `date` detection is now value-checked, GNU probed first — previously a file named `1` in the working directory could misclassify GNU `date` as BSD.
- Lib/doctor: the stale-tombstone warning no longer suggests `/agent:crons reconcile` to "prune old tombstones" (nothing purges tombstones — they are deliberately kept so deletions stay resurrection-proof); the hint now says exactly that.

### Changes

- Bin/cron-from: the `.cron-last-stamp` proof-of-use file gains a third line carrying the one-shot's target epoch (empty for recurring). Hooks/cron-posttool persists it into the registry as `targetEpoch` when the stamp cron matches the captured cron.
- Skills/crons (writeback): new `prune-expired` subcommand — tombstones `recurring=false` entries whose explicit `targetEpoch` already passed (zero date heuristics, so reminders more than a year out can never be misread as expired), and reports legacy date-shaped entries as suspects without ever mutating them; intentional annuals (created more than 7 days ahead of their date) are never flagged. Hooks/reconcile-crons runs it right after seed-defaults, best-effort (a prune failure can never abort the reconcile), and surfaces pruned/suspect lines in the session banner. The registry transform is shape-validated before the atomic write so a failed jq can never replace the registry with an empty file.
- Skills/channels: `idle_other_instance` guidance updated for claude-whatsapp ≥ 1.21 — the waiting session now takes over the lock automatically when the holder exits; a full relaunch is only needed on older channel versions.
- Lib/channel-detector: recognizes claude-whatsapp 1.21's new `connect_error` runtime status as a problem state (WhatsApp side could not start, server retrying), so `/agent:channels` and doctor surface it instead of showing an unknown status.
- Skills/crons (import): OpenClaw `schedule.kind: "at"` jobs now register with `--target-epoch`, so imported dated reminders are properly retired by `prune-expired` after they fire instead of relying on the suspect report.
- Docs/crons: `targetEpoch` field, sliding-marker semantics, prune flow and new failure-mode rows documented; removed the stale "tombstones purged after 30 days" claim (nothing purges; doctor warns). Docs/hooks: SessionStart description updated to the registry reconcile (the legacy `.crons-created` marker flow is long gone). Docs/INDEX: added the missing cron-persistence row to the Core table.

### Compatibility

- Registry schema change is additive only (`targetEpoch`, default `null`); `version` stays 1 and existing registries are untouched until entries are created or updated. The stamp file stays backward-compatible — the pretool gate still reads only lines 1-2. No tool-signature, config, or scope changes.

## [1.7.4] — 2026-05-30

### Fixed

- **`/agent:channels` now surfaces a locked-out WhatsApp server instead of reporting it as fine.** The channel detector previously only checked that `status.json` *existed*; it never read the live `status`. So when a second session held the WhatsApp single-device lock (common after an in-session update/reload, or when a background/service/scheduled session was still alive), `/agent:channels` showed `active: ❓` and the agent stayed silent while the user saw "typing…" on their phone but got no reply. The detector now reads `status.json`, exposes a `runtime` field (status, holder PID, `inboundActive`, remediation), marks the channel `active: no` on a problem state (`idle_other_instance` / `logged_out` / `lock_error`), and `channels_detect({ format: "table" })` prints a **⚠️ Runtime** block with the fix. The `channels` skill is updated to lead with this warning and to never suggest `/whatsapp:configure reset` for a lock-ownership problem. Pairs with claude-whatsapp 1.20.1, which writes the enriched status.

## [1.7.3] — 2026-05-30

### Why this release matters

The agent importer copies an OpenClaw agent's daily memory logs into the new workspace's top-level `memory/*.md`. Those logs often summarize WhatsApp/Telegram conversations — but once they live under `memory/`, the channel-scope engine classifies them as `local` provenance and passes them through unfiltered, even with scope armed in `enforce`. The scope engine is correct (channel content is meant to arrive via `memory.extraPaths` or the `memory/.scoped/` lane, where it carries `channel` provenance); the gap was that import dropped channel-derived content into the wrong lane, where dreaming never reclassifies it. This release adds a content guard to the import flow so that material is flagged and the user decides its fate before it can silently bypass scope. No change to the scope engine.

### Fixes

- Skills/import: new "channel-content guard" (Step 5a) scans copied dated daily logs for channel markers (WhatsApp/Telegram JIDs, `t.me/`, voice-note phrasing, `wacli`/`baileys`) and, when matched, offers quarantine (to a non-indexed `./import-quarantine/`), skip, or import-as-local-with-acknowledgment — instead of silently landing chat summaries in `memory/*.md` where they'd be mislabeled `local` and bypass channel-scope filtering. `MEMORY.md` is scanned warn-only (never auto-quarantined). Flagged files are recorded in `IMPORT_BACKLOG.md` and surfaced in the import report.
- Skills/import: Step F now clarifies that adding a messaging plugin's log dir to `memory.extraPaths` is the correct provenance lane for channel history (it gets `channel` provenance via `deriveChannelHint`), in contrast to chat summaries copied into `memory/*.md`.

### Compatibility

- Import-skill instruction text only — no code, schema, config, or tool-signature changes; `lib/scope/*` is untouched. Affects future imports only; already-imported workspaces are unchanged.

## [1.7.2] — 2026-05-30

### Why this release matters

Hardens the agent against display-name impersonation on messaging channels. A WhatsApp push/display name is user-controlled, so a non-owner can set their name to the owner's; an agent that reasons about "who is this" from the name (rather than the JID) can be tricked into treating a stranger as its owner — and into recording that false identity in memory. This release bakes JID-based identity rules into the agent's always-loaded instructions and workspace templates. Delivered via the runtime MCP instructions, so existing agents pick it up on their next session without re-scaffolding. Pairs with claude-whatsapp 1.20.0, which emits the authoritative `is_owner` / `user_id` / `display_name_unverified` fields these rules rely on.

### Changes

- Runtime MCP instructions gain a "Sender identity — never trust a display name" section: owner identity is the channel's `is_owner` flag (JID-based), never a display name; `display_name_unverified` / legacy `user` / quoted-author / contact-card / profile names are spoofable labels; in groups every participant is non-owner unless `is_owner` is true; and the agent must never record in memory that a JID "is the owner" or that two JIDs are "the same person" based on a name. Includes a recovery path so a real owner whose group JID isn't registered isn't stonewalled (pointed to the owner DM / `set-owner` flow).
- The same rules are added to the workspace templates (`templates/CLAUDE.md` messaging section, `templates/SOUL.md` boundaries) and to both `AGENTS.md` and `templates/AGENTS.md` safety sections, so new agents get them in their workspace files too.

### Compatibility

- Instruction / template text only — no code, schema, config, or tool-signature changes. Existing workspaces get the runtime-instruction rules immediately; their on-disk `CLAUDE.md` / `AGENTS.md` / `SOUL.md` are unchanged (only new-workspace templates are updated).

## [1.7.1] — 2026-05-18

### Why this release matters

ClawCode 1.6.0's always-on protected-paths defense refuses MCP `Write` to `agent-config.json` and channel `access.json` regardless of mode — by design for security, but two legitimate setup flows broke as a side effect. The first-run bootstrap wizard (every new user) couldn't write its own `agent-config.json`; `/whatsapp:access pair <code>` couldn't write `access.json` when the channel state-dir resolves to the global fallback `~/.claude/channels/whatsapp/`. Both flows now route the file write through a hardened Bash heredoc pattern. The protected-paths defense applies to file-tool writes only; Bash is gated separately by the exec-gate hook and doesn't fire during user-driven setup. No behavior change for users who already completed setup on 1.5.0 or earlier. Pairs with claude-whatsapp 1.19.1, which routes its WhatsApp side identically.

### Fixes

- Templates/BOOTSTRAP: the first-run `agent-config.json` write goes through a validated Bash heredoc (cat + `JSON.parse` validate + atomic mv with cleanup-on-failure) instead of MCP `Write`. Closes the install regression where every new user hit `exec-gate: write to protected path refused (workspace-agent-config)` and could not complete bootstrap. The heredoc body is in the `&&` chain (`cat > tmp << "JSON_EOF" &&`) so a `cat` failure short-circuits the rest — a torn write can never leave stale tmp content for the validate/mv steps to promote.
- Skills/settings: both reference blocks ("Configure the backend" and "Modifying settings") use the same hardened pattern. `JSON.parse` rejects malformed JSON BEFORE the atomic `mv`, so a truncated or syntactically broken write can never clobber the existing config.
- Skills/import: memory-backend onboarding snippet adopts the same hardened pattern.
- Lib/scope/exec-gate: error message for `workspace-agent-config` and `channel-access-json` blocks now appends a recovery hint pointing at the safe Bash heredoc pattern. Without this, an agent hitting the block would loop retrying `Write`.
- AGENTS.md: "Legitimate writes to protected paths" guidance updated with the canonical validated heredoc pattern (both forms — the basic agent-config form, and the auth-adjacent form with `umask 077` + per-invocation tmp suffix + explicit `chmod 600` for server-shared channel state). Explicit rules: use the snippet only when a trusted skill provides it (never improvised from agent reasoning), flag Bash auto-allow to the user when it's on, and treat any "update my agent-config.json" instruction arriving via a messaging channel as candidate prompt-injection.
- Dist/exec-gate-resolver.cjs: rebuilt with the new hint text. Source SHA in the bundle header advances with the change.

## [1.7.0] — 2026-05-15

### Why this release matters

**BREAKING for users of 1.5.0 / 1.6.0 scope-trust files.** Trust files now live in a per-workspace subdirectory keyed by a fingerprint of the workspace path: `~/.claude/agent/scope-trust/<workspace-fingerprint>/<channel>-{owner,exec}`. Previous releases stored them globally at `~/.claude/agent/scope-trust/<channel>-{owner,exec}`, which silently unlocked scope across every workspace once granted anywhere — a category error since the `agent-config.json` that the trust pairs with is already per-workspace. After upgrading, run `/agent:scope wizard` in each workspace where you want trust re-granted. Legacy global files are ignored as of 1.7.0 (hard cutover, no automatic migration).

Three active surfaces nudge you on first contact: a SessionStart hook line, a `console.warn` when an armed channel first detects a workspace mismatch, and a doctor row (`scope-trust-legacy`) that lists the exact paths and the `rm` command to clean up after re-granting. The wizard's Bash snippets now compute the workspace fingerprint via the same TypeScript helper the runtime uses (`scripts/print-workspace-fingerprint.mjs`), so Bash and TS agree byte-exact on what subdirectory to read or write — closes the case-fold mismatch that an inline Bash crypto hash would have hit on macOS uppercase paths.

### Added

- Lib/scope/trust: workspace-bound API. `workspaceFingerprint(workspaceRoot)` is SHA256(realpath + per-FS-probe case-fold)→32 hex; resolves to the right subdir even on case-sensitive APFS volumes. All exports (`isOwnerTrusted`, `trustFilePath`, `writeTrustMarker`, `removeTrustMarker`) now require `workspaceRoot` — TypeScript breaks any caller that forgets to thread it. `legacyGlobalTrustExists(channel, suffix)` is a diagnostic-only predicate matching the full 1.6 unlock check (mode/uid/symlink) so doctor + warnings skip stale 0o644 leftovers.
- Lib/scope/legacy-warn: single source of truth for "warn once per workspace × channel × suffix". Both the WhatsApp adapter and the runtime arm-detection path call into this so users see exactly one stderr advisory per upgrade-cliff event. FIFO-256-capped Set survives adapter rebuilds across the 5s runtime cache TTL.
- Lib/scope/canonical-path: extracted `canonicalize` + `isWorkspaceCaseInsensitive` from `filter.ts` + `protected-paths.ts` into a shared module so the trust primitive and the filter share a single cache + probe implementation. Per-workspace probe inspects an actual flippable entry inside the workspace via inode compare — the platform-default heuristic was over-folding case-sensitive APFS volumes.
- Lib/doctor: `checkScopeTrustLegacy` walks `<scope-trust-dir>/` for pre-1.7 flat-layout files, gates each through `legacyGlobalTrustExists`, and surfaces the exact paths + `rm` recovery command. Reports `ok` when the dir is absent or contains only 1.7+ fingerprint subdirs.
- Hooks/scope-trust-legacy-warn.sh: SessionStart advisory. Silent when no legacy files; one-line stderr when present. Workspace-scoped dismissal marker at `<scope-trust-dir>/<fingerprint>/.scope-trust-legacy-dismissed` (dismissing in workspace A doesn't silence the advisory in workspace B).
- Scripts/print-workspace-fingerprint.mjs: bridge from the wizard's Bash to the TS helper. Invoke via `node "$CLAUDE_PLUGIN_ROOT/node_modules/tsx/dist/cli.mjs" "$CLAUDE_PLUGIN_ROOT/scripts/print-workspace-fingerprint.mjs" "$PWD"`. Plugin-local tsx binary — `npx tsx` from arbitrary cwd is unreliable.

### Changes

- Skills/scope/SKILL.md: every Bash snippet that creates or removes a trust file now opens with `set -euo pipefail`, guards `CLAUDE_PLUGIN_ROOT`, validates the bridge-script hash against `^[0-9a-f]{32}$`, sets `umask 077`, and writes to `~/.claude/agent/scope-trust/<fingerprint>/<channel>-<suffix>`. Hardened against empty hashes, missing plugin root, and umask leaks. `/agent:scope disable` removes BOTH trust files for THIS workspace only.
- Lib/scope/whatsapp: `WhatsappAdapterOptions.workspaceRoot` now required. Closure captures workspaceRoot at construction time; `ScopeAdapter` interface unchanged. Read-scope owner unlock + background `system-owner` unlock consult `isOwnerTrusted(workspaceRoot, "whatsapp", suffix)` against the per-workspace path. Migration warn for the read-scope case routes through `legacy-warn.ts` (no duplicate Set).
- Lib/scope/runtime: passes `workspaceRoot` to the adapter; calls the shared `warnLegacyTrustMigrationOnce` helper for both `owner` and `exec` suffixes on first arm so users with legacy exec trust get the hint at runtime detection time too (not only at first exec-gate fire).
- Lib/scope/exec-gate: enforce + shadow branches both surface the `legacy global exec trust ignored for this workspace` diagnostic suffix when workspace-scoped exec trust is missing AND a valid 1.6 global file exists. Shadow event payload gains `legacyGlobalExecTrustIgnored?: boolean`. `effects.isOwnerTrusted` signature now takes `workspaceRoot`; default forwards to the workspace-bound implementation.
- Lib/scope/exec-gate-hook-entry: workspaceRoot is normalized at the hook boundary via `path.resolve` + NUL-byte rejection + absolute-path validation. Fails CLOSED (exit 2, stderr `exec-gate: unable to resolve workspaceRoot — fail-closed`) instead of the top-level `.catch(() => 0)` fail-open path.
- Lib/doctor: `checkScopeOwnerAssertion` now consults `isOwnerTrusted(workspace, channel, "owner")` instead of constructing the legacy direct path, so a leftover 1.6 file doesn't surface as "acting as owner" in 1.7.
- Hooks/hooks.json: `SessionStart` array gains a second entry for the new legacy-trust advisory hook. Existing `reconcile-crons.sh` invocation preserved unchanged.
- Docs/channel-scope-compat: new "Trust files are per-workspace" subsection. PRIVACY.md / README.md / AGENTS.md updated to describe the per-workspace model + migration cliff.
- Package.json: bumped 1.6.0 → 1.7.0. `test` script now also runs `scope-trust`, `scope-trust-workspace`, and `scope-trust-legacy-hook` suites.

### Migration

1. **Upgrade ClawCode to 1.7.0** (via `claude plugin update` or however you installed it).
2. **Open each workspace** where you previously had scope enabled.
3. **Run `/agent:scope wizard`** and select the same options you had before (owner / guest, shadow / enforce, denylist / allowlist). The wizard recreates the trust files under the new per-workspace path via Bash prompts.
4. **Run `/agent:doctor`** — the `scope-trust-legacy` row lists every 1.6 global file with the exact `rm` command. Copy-paste and run to clean up.
5. **Repeat per workspace** where you want trust. Granting in one workspace does NOT bleed to another.

If you don't migrate: scope features silently degrade to guest in those workspaces. The agent surfaces a one-line warning on SessionStart + a warning when an armed channel first fires + a doctor row, so the cliff is loud rather than silent.

## [1.6.0] — 2026-05-14

### Why this release matters

ClawCode now ships an **execution gate**: an optional guardrail that blocks destructive tools (Bash, Write, Edit, Task, and more) when the current Claude Code turn was triggered by a non-owner message from a paired group chat. Companion to the read-scope filter shipped in 1.5.0 — read scope governs what the agent SEES; the execution gate governs what it CAN DO. Default is `off`, so existing users who don't opt in see zero change. Activate via `/agent:scope wizard` with a denylist (recommended) or allowlist policy, in `shadow` (observe-only) or `enforce` modes. A separate out-of-band trust file (`~/.claude/agent/scope-trust/<channel>-exec`, created via Bash) lets you opt out of the gate on a trusted machine without disabling read scope.

The gate is hardened against agent self-modification: protected-paths refuses MCP writes to plugin internals, the gate's own source files, channel governance, SSH/credential dirs, shell init, and persistence mechanisms (LaunchAgents, systemd user units) — even with the gate set to `off`. Subagent spawn (`Task`) is hard-denied along with `Bash` when the gate fires, closing a Claude-Code-specific bypass surface where hooks don't propagate to subagents.

### Added

- Skills/scope: `/agent:scope wizard` extended with 3 new steps (activate exec gate Y/N → denylist or allowlist policy → trust this machine for exec Y/N). `/agent:scope status` surfaces per-channel `execGate.{mode, policy, tool-set source, trust validity}`. `/agent:scope test exec <senderJid> <toolName>` invokes the real resolver via `npx tsx -e` with injected envelope reader + no-op shadow recorder. `/agent:scope disable` resets BOTH read-scope mode AND execGate to off, removes BOTH `<channel>-owner` and `<channel>-exec` trust files.
- Hooks/exec-gate-pretool.sh: PreToolUse hook scans recent inbound envelopes from paired messaging channels and applies the configured deny/allow policy. Hot path (mode=off) p95 = 8 ms via conservative jq probe; armed path p95 = ~65 ms via pre-built CJS bundle. Hard-denies `Bash` and `Task` under any non-owner-in-window state regardless of policy.
- Dist/exec-gate-resolver.cjs: pre-built CommonJS bundle (~52 KB) invoked by the hook. Bundle header carries a SHA256 over the source-file tree so a tier1 test fails CI if anyone hand-edits the bundle or forgets to rebuild after touching scope source. Build via `npm run build:hook`.
- Lib/scope/exec-gate: pure-function resolver decides allow / block / shadow based on the envelope-window scan + trust-file unlock + policy. Aggregates "any non-owner sender present" across all armed channels (most-restrictive wins: enforce over shadow). Synthesizes a non-owner hit when channel governance is unresolvable (fail-closed under `mode != off`).
- Lib/scope/protected-paths: always-on classifier (mode-independent). Refuses MCP writes to plugin internals (hooks, resolver bundle, exec-gate source files), `agent-config.json`, scope-trust dir, `~/.claude/`, `~/.ssh/`, credential dirs (`~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`), shell init files, LaunchAgents / user systemd units, `.mcp.json`, `.claude-plugin/plugin.json`, and every configured channel's `access.json`. Realpath canonicalization + case-fold defends against symlink-alias and case-quirk bypasses on darwin/win32.
- Lib/scope/exec-gate-shadow-log: append-only writer for `memory/.execgate-shadow.jsonl`. Records would-block decisions with full replay metadata (effectiveMode, policy, expandedTools, hookVersion, configHash, lookbackMs, windowEnvelopeCount). Atomic 1 MB rotation with advisory lock + symlink defense.
- Lib/scope/trust: `isOwnerTrusted(channel, suffix)` extension accepts `"owner" | "exec"`. The two trust files are independent — neither implies the other. Both are created via Bash (user permission prompt), never by the agent through MCP.
- Lib/config: `ChannelScopeConfig.execGate?` extension (`mode | policy | tools | lookbackMs`). Absent block = `mode: "off"`. Coercion is fail-closed: malformed sub-fields (invalid `policy`, non-string-array `tools`, overflow `lookbackMs`) escalate the whole block to `enforce + denylist + defaults`.
- Lib/doctor: 2 new checks — `scope-execgate-status` (per-channel info row with mode/policy/tool-source/trust validity from `isOwnerTrusted` — distinguishes `yes` from `invalid` from `no` so the user can see when a trust file exists but won't actually unlock) and `scope-execgate-shadow-events` (parses shadow log defensively, warns when recent events are within 7 days to prompt review before flipping to enforce).
- Scripts/build-exec-gate-hook.mjs: `npm run build:hook` runs esbuild with `--metafile`, auto-discovers source files via metafile inputs (no hand-maintained list), prepends a SHA256 header, and normalizes Windows backslash paths.
- Lib/scope/channel-hint: extracted from `lib/scope-audit.ts` so the hook bundle doesn't drag better-sqlite3 in transitively.

### Changes

- Docs/channel-scope-compat: "Execution scope" section expanded with the shadow-log review path, `Task` hard-deny rationale, and the full protected-paths list.
- PRIVACY.md: new "Execution scope" subsection documents what the gate covers and does NOT cover (memory poisoning across turns, reply egress, terminal-side user actions, within-lookback envelope replay).
- AGENTS.md: guidance for the agent when a PreToolUse block hits stderr — don't retry, don't rewrite the same intent as a different tool, surface the reason to the user.
- Package.json: `test` script now also runs `scope-exec-gate`, `scope-exec-gate-e2e`, `scope-exec-gate-doctor` tier1 + tier2 suites. New `build:hook` script.

## [1.5.0] — 2026-05-13

### Why this release matters

Brings a brand-new opt-in privacy layer to indexed channel content. When you pair ClawCode with `claude-whatsapp` (or any future channel plugin that publishes per-chat history scope), search/recall/dreams/voice now respect that scope automatically — without flipping anything for users who don't opt in. Adds a security hardening pass on path-bearing config keys, a privacy fix to WebChat's per-tab history, and per-chat binding for memory tool calls so concurrent inbounds from different chats can't bleed scope across each other.

### Added

- Skills/scope: new `/agent:scope` skill suite — `wizard` (interactive setup), `enable`, `disable`, `status`, `test <chatId>` (dry-run), `audit`. Wizard walks the user through choosing a channel, mode (`off | shadow | enforce`), foreground identity (`owner | auto | guest`), and background-task identity (`deny | system-owner`). Owner unlock requires an explicit trust file at `~/.claude/agent/scope-trust/<channel>-owner` written via Bash so the agent cannot silently elevate itself. First wizard apply emits a one-time banner explaining that MCP scope is not a filesystem sandbox (native `Read`/`Grep`/`SQLite` calls still see raw files); subsequent runs skip the banner.
- Lib/scope: per-channel opt-in scope tree under `config.scope.<channel>`. Defaults to `off` everywhere — absent config means zero behavior change. Three modes: `off` (no-op), `shadow` (logs what would be filtered but returns everything), `enforce` (filters). Channels recognised today: `whatsapp` (full), `telegram` / `discord` / `imessage` / `webchat` (config plumbing only, awaiting publishers).
- Lib/scope/whatsapp: adapter mirrors upstream `claude-whatsapp/scope.ts` byte-exact — owner unlock with trust file, bootstrap fail-open only on auto-discovered installs, per-chat `historyScope` (`'own' | 'all' | string[]`) honored. Hardened access.json reader with mtime+size+inode cache, forward-compatible normalizer (drops unknown enum values, preserves last-known-good on parse failure), 5-min grace window when access.json briefly disappears.
- Lib/scope/synthetic-indexer: per-chat synthetic chunks generated from upstream `messages.db` (read-only, WAL-respecting) under `extra:claude-whatsapp/messages-db/<chat_id>/<YYYY-MM-DD>`. Replaces the prior daily-transcript chunks for per-chat semantics. Cursor + dev:ino identity stored across restarts, in-place truncation and rowid reuse detected and recovered, throttled reconciliation walks the full chunk set to catch edits and deletes upstream, PII quarantine on confirmed (ENOENT) DB absence with 24h grace window.
- Lib/scope/dreams: dual-lane promotion. Local-only memory candidates still promote to `memory/MEMORY.md`. Candidates from an armed channel route to `memory/.scoped/<channel>/MEMORY.<encoded-chat>.md` (`chmod 0700`/`0600`), with PII redaction markers (`<scoped:<channel>:<8-char-hash>>`) on DREAMS.md, MEMORY.md routing comments, and dream response payloads. Mixed candidates fall to worst-contributor-wins so cross-chat aggregations never silently land in the unscoped lane. Exclusive O_EXCL lock file with cross-host timestamp grace + same-host PID liveness probe.
- Lib/scope/envelope: cross-plugin request envelope contract. When `claude-whatsapp` 1.19.0+ is installed and an inbound triggers an agent turn, ClawCode's `memory_search` / `memory_get` / `memory_context` / `voice_transcribe` MCP tools accept an optional `requestEnvelopeToken` arg. With the token forwarded, scope decisions bind to that specific inbound's chat/sender. Without it, behavior is unchanged. Reader hardened against symlink/uid/mode/short-read/oversize/realpath/skew/expired/replayed payloads with bounded-reuse LRU (256 cap).
- Lib/scope/agent-config-guard: classifier blocks `agent_config(action='set')` writes to security-sensitive scope keys (`scope.<channel>.{mode,identity,accessJsonPath,cwdExactMatchOnly,background.identity}`), prototype-pollution paths (`__proto__`, `constructor`, `prototype` at any segment), oversize keys (>256 chars, >16 segments, >64 chars/segment), and a privileged-keys list (`voice.outputDir`, `memory.extraPaths`, `memory.qmd.command` and their ancestors/descendants). Refused writes return a clear out-of-band-confirmation message pointing at the wizard.
- Lib/doctor: new `scope-status` / `scope-stale` / `scope-owner-assertion` / `scope-schema-drift` / `scope-bypasses` / `scope-quarantine-pending` / `scope-wizard-available` / `scope-indexer-health` checks. Proactive offer surfaces `Run /agent:scope wizard` when WhatsApp is paired + authenticated but `scope.whatsapp.mode === "off"`, dismissable via `~/.claude/agent/.scope-wizard-dismissed`. Indexer health surfaces cumulative `pairs_capped` and `reserved_prefix_skipped` counters as warnings when non-zero.
- Lib/scope/lifecycle: file-watcher on `~/.claude/plugins/installed_plugins.json` with 500ms debounce + unrefed timer. Re-runs channel detection automatically on plugin install/uninstall/upgrade so a freshly paired WhatsApp install lights up scope without restart.
- Lib/http-bridge: WebChat per-tab session model. Every `/v1/chat/send`, `/v1/chat/history`, `/v1/chat/stream` request now requires `sessionId` (UUID v4). Two browsers with the same `http.token` cannot see each other's chat history or live agent replies. Per-session message cap (500), pin-on-active LRU (100 unpinned + sentinel buckets outside the budget), SSE-clients-per-session cap (8). Reserved `_legacy` bucket migrates pre-existing JSONL entries (logged before this release added `sessionId`) internally and never escapes any public surface. Watchdog ping path uses reserved `_watchdog` bucket.
- Skills/settings: new `Channel scope (\`scope.*\`)` read-only panel section pointing at `/agent:scope wizard` for changes. Notes the `agent_config` blocklist so the user knows wizard-via-Bash is intentional.

### Changes

- Server: `memory_search`, `memory_get`, `memory_context`, `voice_transcribe` MCP schemas accept an optional `requestEnvelopeToken: string`. Invalid / absent tokens fall back to current behavior (no per-chat binding); valid tokens emit the partial allowlist derived from the envelope's chat/sender. Other channels and unarmed (`mode: off`) configurations are unaffected.
- Lib/dreaming: `applyPreventivePromoteGuard` is channel-aware — drops only candidates from armed channels; candidates from unarmed channels (and locals) fall through to the existing local lane. `routePromotions(promoted, runtime)` exposed for the dual-lane split.
- Lib/memory-db: schema migration adds `chunks.source_channel` / `chunks.source_chat_id` (passive metadata when scope is `off`); batched 1k-row backfill with auto-backup; idempotent on re-run. New `scope_indexer_cursors` / `scope_indexer_metrics` / `scope_synthetic_reconcile` tables. Migration runs once on first launch after upgrade and is a no-op afterwards.
- Lib/memory-db: search now reads stored `source_channel` / `source_chat_id` when populated (falls back to path-pattern derivation otherwise). QMD result paths under any configured `extraPath` reconstruct `extra:<root>/<rel>` correctly (longest-prefix-wins) so channel attribution lands on QMD hits.
- Lib/memory-db: chmod 0700 on `memory/`, 0600 on `.memory.sqlite[-wal/-shm]` so other local users cannot read the SQLite store. New `MemoryDBOptions.headless` skips chmod and fs.watch for read-only diagnostic open paths (doctor).
- Lib/scope/cache: atomic write-temp+rename for `scope-cache.json`, version+updatedAt envelope, last-known-good on parse failure, advisory lock with stale-lock recovery (30s).
- Lib/voice: `voice_transcribe` rejects absolute paths that resolve under an armed channel's `extraPath` unless the call carries a valid envelope (tilde expansion + realpath comparison + longest-prefix-wins; tied-longest fails closed).
- Lib/voice: text-hash binding for `voice.speak` removed. The agent already has the snippet in context once a search returned it; binding text to a snippet hash gave false positives on benign transformations and false negatives on paraphrases. Voice egress remains a documented out-of-scope channel.
- Lib/voice: `voice.speak` output path canonicalized through `realpathSync.native` (case-folded on darwin/win32) and restricted to the configured `outputDir` / `os.tmpdir()` / `/tmp` allowlist. Refuses any path resolving under the trust-file directory.
- Lib/live-config: hot-reload refuses to update privileged scope/voice/memory keys. Preserves the prior in-memory value and surfaces a synthetic `CriticalChange` notification ("/mcp restart needed") with the rejected change visible.
- Lib/channel-detector: `detectWhatsappProjectDir` accepts `cwdExactMatchOnly: true` for callers that must match the workspace exactly and skip the project-root fallback. Default behavior unchanged.
- Lib/skill-manager: `skill_install` and `skill_remove` validate name (slug charset, no separators/NUL, length cap, reject `.` / `..`) and path containment before any filesystem operation.
- Lib/scope/runtime: `detectScopeRuntime(config, workspaceRoot?)` threads workspace through `resolveAccessPath(cfg, baseCwd)` so detached / background spawns resolve the correct channel directory.
- Lib/scope/filter: SQL pre-filter emits partial-allowlist clauses (`(chunks.source_channel != ? OR chunks.source_chat_id IN (?, ?, …))`) so partial allowlists don't trigger an O(N) per-row gate.
- Lib/types: `SearchResult.provenance?` + `scopeToken?` (passive metadata; populated whenever search returns a row from a known-channel path).
- Lib/scope/provenance: path containment is separator-safe + `realpathSync`-resolved with mtime+size+ino-keyed cache (inode change invalidates cache on atomic-replace). Fails closed if `realpathSync` throws.

### Fixes

- Server: `chat_inbox_read` gates on `runtime.channels.webchat?.armed === true && mode === "enforce"`. Unreachable today (no webchat adapter ships), but the gate is in place for a future publisher.
- Lib/scope/runtime: `applyPreventivePromoteGuard` now resolves the live runtime via `detectScopeRuntime(loadConfig(pluginRoot))` instead of a default-arg fallback. Previous code returned no-armed AND purged adapters mid-session, leaking channel chunks into MEMORY.md and clearing adapter state. Adapters are purged only on explicit re-detection or no-scope branches.
- Lib/memory-db: `MemoryDB.search` over-fetches `maxResults * 8` candidates when an adapter is armed so post-filter refill from locals matches `maxResults`. Unarmed path unchanged (no over-fetch).
- Lib/scope/whatsapp: explicit `guest` / `deny` config now beats bootstrap fail-open. Malformed access.json with missing `ownerJids` field is rejected instead of masquerading as bootstrap.
- Lib/scope/whatsapp: marker file (`<channel-dir>/.last-inbound.json`) is reader-side hardened — `O_NOFOLLOW` + `O_NONBLOCK` + single-fd `fstat` + mode `& 0o077` + wrong-uid + future-skew (5s tolerance) + non-regular-file rejection + 4 KiB read cap. Reader runs for cache eviction side-effects only and is no longer consulted for owner unlock (identity primitive replaces it).
- Lib/qmd-manager: when scope is armed and the partial allowlist is non-null/null-non-empty, QMD is skipped for the scoped query because QMD's external index doesn't honor `source_chat_id`. Owner unlock (allowlist === null) keeps QMD in the path.

### Compatibility

- Zero behavior change when `config.scope.*` is absent. The plugin works exactly as before for users who do not opt in.
- Old `claude-whatsapp` paired with new ClawCode: per-chat semantics fall back to the owner-only ceiling (no `requestEnvelopeToken` in the inbound). Owner unlock via the trust file is unaffected. Recommend updating `claude-whatsapp` to 1.19.0+ to get the full per-chat guarantee.
- New `claude-whatsapp` paired with old ClawCode: old ClawCode silently ignores the envelope token and continues on its pre-1.5.0 path. No upstream breakage.
- The synthetic indexer is a no-op for users without `scope.whatsapp.*` configured. Existing daily-transcript chunks coexist as legacy entries.


## [1.4.14] — 2026-04-21

### Changes

- Docs/wsl2: publish `docs/wsl2.md` — a Windows-via-WSL2 install guide that walks users from zero to a running agent. Opens with a "where is your Claude Code running right now?" diagnostic (`uname -a` tells them whether they're already inside WSL2 or stuck on native Windows), so a Windows user with an existing native Claude Code install doesn't silently install ClawCode into an environment where the Linux code paths can't run. Then: PowerShell `wsl --install -d Ubuntu-22.04`, Ubuntu deps (`nodejs npm jq git`), a separate Claude Code install inside WSL2 (coexists with any native install), ClawCode plugin install, systemd user service with `loginctl enable-linger` for logout survival, and a "what works / what doesn't" section (iMessage is the one exclusion; `say` TTS auto-skips; `memory.extraPaths` inherits the native-Linux recursive-watch caveat, linked through to `docs/memory.md`). Closes the recurring "does this run on Windows?" question by documenting the existing Linux code path — nothing in the plugin needed to change architecturally because WSL2 reports `process.platform === "linux"` and every platform-gated path (`lib/service-generator.ts`, `lib/channel-detector.ts`, `lib/voice.ts`, hooks) already takes the Linux branch.

- Docs/service: replace the "Windows / BSD / other — Not supported" row in the supported-platforms table with two rows — `Windows (via WSL2) → systemd (--user)` pointing at `docs/wsl2.md`, and a separate row for native Windows / BSD / other which remain unsupported. Reflects reality: the Linux systemd path already covers WSL2 end to end.

- Plugin/readme: badge now advertises `macOS | Linux | Windows (WSL2)` — "Windows" explicit so scanning users on Windows see their platform listed — and Prerequisites adds a one-liner directing Windows users to `docs/wsl2.md`.

### Fixes

- Lib/service-generator: the unsupported-OS error emitted by `/agent:service install` on native Windows used to send users straight to Task Scheduler; it now points them at WSL2 + `docs/wsl2.md` first (the path that actually works for the full plugin surface) and keeps Task Scheduler as the native-only fallback. User-visible string only, no behavior change — verified by the existing `tests/service-generator-smoke.test.ts` (28/28 pass) and `tests/whatsapp-detection.test.ts` (14/14 pass).

## [1.4.13] — 2026-04-19

### Changes

- Hooks/reconcile: emit a 4-line session banner at the top of every SessionStart — `=== CLAWCODE v<version> · MIT License ===`, docs/config link, an `/agent:doctor` tip, and a neutral issues/feedback invite. Version is read at runtime from `plugin.json` (jq with a `sed` fallback for jq-missing environments), so it never drifts from the manifest. Additive only: identity injection, the cron reconcile envelope, the `BOOTSTRAP.md` early-exit, and the jq-missing degraded path are all unchanged. Wording kept to functional support copy (no engagement asks like "star us") to stay clear of Anthropic's Software Directory Policy §4.C on promotional content. Gives users who installed from either marketplace an in-context pointer to the docs/repo on every session, matching the professional-CLI convention (psql, node REPL, Rails console).

## [1.4.12] — 2026-04-19

### Fixes

- Docs/readme: add a Troubleshooting bullet explaining that `/plugin update clawcode@agent` can stay silent for several minutes (Claude Code downloads and installs the new version in the background with no progress indicator) and that `/plugins-reload` is a useful follow-up to make sure the running session picks up the new cache before the next turn. Surfaced after v1.4.11 shipped — Cloudy paused for a few minutes on update and looked hung when it wasn't.

- Skills/about: reorder the "Format per surface" section so the tail-line language rule appears first and the EN default is the visual template on every surface (CLI/WebChat, WhatsApp, Telegram). The `<tail-line-in-user-language>` placeholder replaces the inlined example, with explicit EN/ES/PT translations listed once under the rule. Behavior unchanged — agents still adapt to the user's conversation language — but the old layout showed the ES tail inside the WhatsApp template, which could induce a wrong ES default for no-signal sessions.

## [1.4.11] — 2026-04-19

### Fixes

- Skills/crons: `writeback.sh upsert` now refuses (exit 5) if an active entry with the same `cron` + `prompt` already exists under a different key, turning ⛔ rule #4 from doctrine into an enforced invariant. Blocks the "PostToolUse hook captured the CronCreate as `harness-<id>`, agent also ran a manual `upsert` with a custom key" pattern that silently created double-firing reminders (observed 2026-04-19: one reminder dispatched two live harness jobs and left an accidental recurring-true entry firing annually forever). `--source openclaw-import` is exempt because legitimate batch imports may carry repeated payloads. Tombstoned entries are ignored by the guard so re-created crons register cleanly. See `docs/crons.md` failure-modes table.

- Hooks/cron-pretool: new `PreToolUse` hook that gates `CronCreate` on a recent `bin/cron-from.sh` stamp, turning ⛔ rule #1 ("never compute cron expressions yourself") from doctrine into an enforced invariant. Blocks with exit 2 and a stderr message if no stamp exists, the stamp is older than 120s, or its cron doesn't match `tool_input.cron`. The helper now writes `memory/.cron-last-stamp` after every successful invocation. New `cron-from.sh passthrough "<cron>"` mode covers arbitrary 5-field expressions (e.g. `"0 0 * * 0-3"`) that don't fit `relative`/`absolute`/`recurring`. Reconcile retains the existing `.reconciling`-marker bypass so SessionStart replays are never gated. Justified by a second empirical repro of the same mental-math violation on the same day: even with rule #1 in SKILL.md, Cloudy skipped the helper and fell back to `date`+arithmetic — doctrine alone was not enough.

- Detect/whatsapp: align `channel-detector` and `voice` with the `claude-whatsapp` v1.x public state contract. The auth probe now checks `<project>/.whatsapp/status.json` (written only after a real pairing event) instead of the `auth/` directory, which the plugin creates empty at startup — that caused `/agent:channels` to report "authenticated" on installs that had never scanned a QR. The voice audio detector reads the new top-level `audioTranscription` / `audioLanguage` fields the plugin now writes, replacing the legacy nested-object fallback. Both detectors resolve the plugin's project-local install path via `~/.claude/plugins/installed_plugins.json`, so the multi-agent layout (plugin installed in Project A, agent running from Project B) now resolves to Project A's state correctly instead of silently falling back to the global dir.

## [1.4.10] — 2026-04-19

### Fixes

- Skills/about: add the missing `skills/about/SKILL.md` so `/about` and `/version` actually execute. v1.4.7 announced the commands and wired the response format into `templates/CLAUDE.md`, but without a skill file they were never discovered by `list_commands` / `discoverCommands(...)` — so on real agents (WhatsApp, custom personas like Cloudy) the slash command fell through to persona free-form intros instead of the ClawCode version card. New skill covers both `/about` and `/version` (plus `/agent:about`, `/agent:version`, and natural-language triggers), reads the version via `watchdog_ping` MCP tool with `plugin.json` as fallback, and adapts bold formatting per surface (CLI/Telegram `**bold**` vs WhatsApp `*bold*`). Verified via `tier1c-skill-files.ts` (58/58) and live `discoverCommands(...)` against the real workspace (plugin skills 18 → 19, `about` shows up with all 8 triggers parsed).

## [1.4.9] — 2026-04-19

### Changes

- Skills/release: relocate the maintainer release flow to operator scope, out of the published plugin payload. Plugin manifest, end-user agent config, and runtime behavior unchanged.

## [1.4.8] — 2026-04-19

### Changes

- Skills/release: adopt OpenClaw's release-notes format as the canonical style for both CHANGELOG entries and `gh release` bodies. Two groups only (`### Changes` / `### Fixes`, no Added/Removed/Changed sprawl), bullets prefixed with `Area/subarea:` scope, one-line narrative + outcome, optional `(#PR) Thanks @user.` suffix, link back to CHANGELOG at the end. Mirrors the conventions used by `openclaw/openclaw` (~360k stars) so anyone landing on the ClawCode releases page reads them the same way they read OpenClaw's. Concrete worked example added to the skill body.

## [1.4.7] — 2026-04-19

### Added

- **`/about` and `/version` slash commands** for the agent. Responds with a 3-line card (`🔌 *ClawCode* v<version>` + repo URL + invitation to file issues / star). The version is read dynamically from `$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` so it never goes stale. Recognized on every channel (CLI, WhatsApp, Telegram, Discord, iMessage). Surfaces the repo to users who installed via marketplace and would otherwise have no way to find docs / file issues / star the project from inside their agent. Pattern lifted from OpenClaw's HOOK.md `homepage` field convention but inverted: instead of metadata-only discovery via `/plugin` viewer, this is an active surfacing the agent can do mid-conversation when asked. Templates/CLAUDE.md updated; `/help` table includes the new command.
- **`skills/release/` — the release flow as an actual skill**, not just a memory. Documents the 4 mandatory steps for cutting a new ClawCode plugin release (bump versions in both manifests, move `[Unreleased]` to `[X.Y.Z]` in CHANGELOG, commit + push, AND `gh release create`). Exists because the agent maintaining the plugin has repeatedly forgotten step 4 — version went into code but no GitHub Release appeared. JC flagged it as a recurring miss on 2026-04-19; this skill makes it impossible to skip. Triggers on `/agent:release`, "cut a release", "ship vX.Y.Z", etc.

## [1.4.6] — 2026-04-19

### Added

- **Plugin metadata for the `/plugin` viewer.** `.claude-plugin/plugin.json` now declares `homepage`, `repository`, `license`, and `author.url` — without these the `/plugin` view rendered the plugin card with no link back to the repo, which meant users who installed via the marketplace had no way to find docs, file issues, or star the project from inside Claude Code. Mirrors the field set already used by `crisandrews/claude-whatsapp` so both plugins surface the same way. Pure metadata, no behavior change.

## [1.4.5] — 2026-04-19

### Fixed

- **Reminders now actually survive `/exit` + relaunch.** Three concatenated bugs in v2.1.114 silently broke the persistence promise of the cron registry; verified end-to-end on a live WhatsApp agent before/after fix:
  - **PostToolUse hook regex was stale.** Claude Code v2.1.114 changed the `CronCreate` `tool_response` from a plain string (`"Scheduled <id> (<cron>)"`) to a JSON object (`{"id":"<id>","humanSchedule":"<cron>","recurring":<bool>,"durable":false}`). The hook's regex looked for the legacy string, missed the object form, and silently exited — every ad-hoc reminder went uncaptured. Hook now parses `.tool_response.id` first and falls back to the regex for older harnesses; same fallback shape added for `CronDelete` (`.tool_response.cancelled`). `tool_response.durable` is `false` regardless of input — the harness is overriding `durable: true` upstream. Confirmed by reading the live payload via a temporary trace hook in the cache directory; trace removed after diagnosis.
  - **`reconcile-crons.sh` fast-path skipped recreation after every restart.** SessionStart hook checked whether all active registry entries had a `harnessTaskId` and, if so, skipped the entire reconcile envelope — assuming "bootstrapped" meant "alive in harness". Combined with upstream `durable: true` being broken, the stale `harnessTaskId` from the dead session was always present, so the envelope was never re-emitted, the agent never recreated the crons, and reminders never fired post-restart. Fast-path removed; the envelope is now emitted on every SessionStart so the agent's `CronList` check authoritatively decides what to recreate. When upstream `durable` lands, this can be re-enabled with a session-scoped staleness signal (e.g. comparing `lastSeenAlive` against session start, or stamping `sessionId` in writeback).
  - **`crons` skill didn't auto-load on natural-language reminder requests.** Description triggered only on `/agent:crons`, `recordatorios`, etc. — phrases like "recordame en X", "remind me in X", "todos los lunes a las Y" never loaded the skill, so the agent fell through to in-session `ScheduleWakeup` (dies on `/exit`) or a verbal-only commitment. Description expanded with the full natural-language trigger set in ES + EN (recordame, recuérdame, me recuerdas, hazme acordar, agendame, avísame, remind me, remind me in, schedule a reminder, every Monday/lunes at, todos los días a las, cada N minutos/horas, etc.).
- **Cron expressions are now computed by a deterministic helper, not the LLM.** New `bin/cron-from.sh` (BSD- and GNU-`date`-aware, single-shot JSON output) handles `relative`, `absolute`, `recurring daily`, `recurring weekly`, `recurring every N`. Skill `crons` ADD subflow rewritten to mandate calling the helper before every `CronCreate`; SOUL.md adds "time commitments are sacred" to the Boundaries block; `templates/CLAUDE.md` adds two CronCreate gotchas (never compute expressions yourself; never use `ScheduleWakeup` for user commitments); `skills/messaging/SKILL.md` cross-references the crons skill for any time-based commitment via messaging channels. The helper exists because LLMs miscompute timezones inconsistently — verified live: same agent in same session generated `52 12 19 4 *` for "12:52 local" (correct) and `33 17 19 4 *` for "13:33 local" (off by exactly the UTC offset). Daemon interprets cron in host LOCAL time (verified empirically); helper does epoch arithmetic and reformats in host TZ so cron + human-display always agree. Includes `tier1q-cron-from.sh` with 27 test cases covering relative units, absolute today/tomorrow, recurring daily/weekly/every, day-of-week named + numeric, error paths, and the exact "in 3 minutes" reproducer that originally surfaced the bug.
- **`hooks/cron-posttool.sh` now has its own test suite (`tier1p-cron-posttool.sh`, 15 tests).** Pre-fix the hook had no unit tests and the regex bug shipped silently. Suite covers both response shapes (modern object + legacy strings recurring/one-shot), captured-field correctness, audit log append, recursion-marker suppression with stale-marker fallback, idempotency, non-Cron-tool ignore, malformed payloads, `CronDelete` tombstoning (success and failure cases), empty-stdin defense, and the failure-mode contract (always exits 0).
- **Documentation (`docs/crons.md`)** — new "Time arithmetic — `bin/cron-from.sh`" section with the full intent → helper-call mapping table; user-commands section now leads with natural-language triggers and notes auto-loading on any future-time commitment via any channel.

## [1.4.4] — 2026-04-19

### Fixed

- **Plugin no longer fails to load on Claude Code ≥ 2.1.114 with "Duplicate hooks file detected".** `.claude-plugin/plugin.json` declared `"hooks": "./hooks/hooks.json"` since v1.0.0, but Claude Code auto-loads `hooks/hooks.json` from the standard plugin path — the explicit declaration was redundant. Recent Claude Code versions added a duplicate-detection guard that rejects the redundant declaration and skips loading every hook (SessionStart reconcile, PostToolUse cron capture, PreCompact memory flush, Stop summary prompt, SessionEnd dreams event). Removed the line; the hooks now load via auto-load, same file, same behavior. Zero impact on older Claude Code: auto-load has always been the documented default, and `manifest.hooks` is spec'd only for *additional* hook files beyond the standard path. New `dev-tests/tier1n-plugin-manifest.ts` regression guard asserts the field stays absent.

## [1.4.3] — 2026-04-18

### Thanks

- **[@JD2005L](https://github.com/JD2005L)** for the version-stamp service-side writer — another production find from his 24/7 ClawCode deployment. Paired with a new in-repo watchdog consumer (see below) to close the silent-stale-code failure mode end-to-end.

### Added

- **Version stamp at service start.** `generateSystemdUnit` and `generatePlist` now write the workspace's current `git HEAD` to a reboot-clean runtime file (`$XDG_RUNTIME_DIR/clawcode-<slug>.version` on Linux, `$TMPDIR/clawcode-<slug>.version` on macOS) before `claude` boots. The service itself never reads the file; it exists so external watchdogs can detect the "user pulled upstream but only ran `/mcp`" case, where plugins keep serving stale code while systemd still reports the unit as active. On Linux this is a best-effort `ExecStartPre=-/bin/bash -c '...'`; on macOS the whole `ProgramArguments` is wrapped in `/bin/sh -c 'git rev-parse HEAD > $TMPDIR/...; exec "$@"'` with the real argv passed as positionals, so a missing `git` or non-git workspace falls through to the normal exec path instead of crash-looping launchd. New exported `versionStampPathExpr(platform, slug)` helper gives consumers the canonical shell expression for the path. `generatePlist` gains a required `slug` option so the stamp filename can be emitted without re-parsing it out of the label. Reported by [@JD2005L](https://github.com/JD2005L) after hitting the silent-stale-code failure mode in production on 2026-04-17. [#22](https://github.com/crisandrews/ClawCode/pull/22).
- **Watchdog tier 6 — version drift detection.** `recipes/watchdog/watcher.sh` gains a sixth tier that reads the service-side stamp, diffs it against `git -C <workspace> rev-parse HEAD`, and returns `FAIL(drift:<old>→<new>)` when they diverge — pushing the existing `--on-fail` restart path to pick up the pulled code. Auto-opt-in: both `install-linux.sh` and `install-mac.sh` append `--tier=6` when the workspace has a `.git` directory, plus a new `--slug=<slug>` argument so the watcher can derive the stamp path per-platform. Non-git workspaces, missing stamps, and missing slugs all silently skip tier 6 — never error out — so the stamp-side's best-effort semantics carry through to the consumer. Without this consumer the stamp was forward-compat infrastructure with nothing in-repo reading it.
- **5 new smoke-test checks for the service-side stamp** (covering per-platform/per-slug path expressions, `ExecStartPre` ordering, the launchd `sh -c` wrapper shape, and `|| true` fallthrough on non-git workspaces) and **5 new end-to-end bash tests for watchdog tier 6** (matching SHA → pass, drift → FAIL, missing stamp → skip, non-git → skip, missing slug → skip). Full smoke-test count: 18 → 28.

### Fixed

- **`/agent:create` now continues the bootstrap ritual inline instead of stopping halfway.** The skill used to tell the user to run `/mcp` and then stop, expecting the agent to "detect BOOTSTRAP.md on next turn and start the ritual". In practice Claude Code doesn't respond without user input, so the user had to type something (e.g. `hola`) before the ritual actually began — three user interactions instead of one. The skill now drives the ritual inline in the same response where the Bash copy steps run. `/mcp` moved to the very end of the ritual, where there are actual memory/config writes for it to pick up.
- **Bootstrap ritual no longer batches every discovery question into a single message.** `templates/BOOTSTRAP.md` listed all discovery items (name, creature, vibe, emoji, human info) as a single bullet block and framed the ritual as "don't interrogate, just talk" — which the model consistently read as "dump every question at once and wait for the user to answer them all in one reply". `CLAUDE.md`'s "Interactive wizards" rule ("one question at a time, `AskUserQuestion` for enumerables") was getting outvoted by the conversational framing of BOOTSTRAP.md itself. Restructured into numbered, sequential steps with an explicit "rule zero: one question per turn" guard-rail at the top of the file. Enumerable choices (vibe, QMD on/off, messaging channel) now call out `AskUserQuestion` explicitly; free text stays for name/creature/emoji. The `agent-config.json` JSON templates moved to a reference section at the bottom so the inline ritual reads cleanly.

## [1.4.2] — 2026-04-17

### Added

- **Listed on Anthropic's `claude-plugins-community` marketplace.** Install via `/plugin marketplace add anthropics/claude-plugins-community` then `/plugin install clawcode@claude-community`. The plugin entry is registered in the official catalog under the name `clawcode` (the marketplace catalog label) — note this differs from the `agent@clawcode` identifier used when installing from this repo's own marketplace, but both install the same code from the same source. The community marketplace syncs nightly from Anthropic's review pipeline, so brand-new fixes can take up to ~24h to land there; install from `crisandrews/ClawCode` directly if you need the absolute latest commit. The two install paths can coexist on the same machine in different workspaces — they live under separate cache directories (`~/.claude/plugins/cache/claude-community/clawcode/<version>/` vs `~/.claude/plugins/cache/clawcode/agent/<version>/`) and Claude Code tracks them as separate `installed_plugins.json` entries.

### Documentation

- `README.md` — Quick Setup install commands now lead with the community marketplace path; the `crisandrews/ClawCode` path is kept as the bleeding-edge alternative for users who need same-day fixes. Update / uninstall / clear-cache sections refactored to cover both install origins explicitly. Troubleshooting row for the "Failed to reconnect" error now lists both possible cache paths. New badge in the header signaling the community listing.

## [1.4.1] — 2026-04-17

### Thanks

- **[@JD2005L](https://github.com/JD2005L)** for two follow-ups from his live service deployment on 2026-04-17: an automatic self-heal for a stuck resume-loop he actually hit in production, and a PATH fix so hooks find `jq` when it's installed user-local.

### Added

- **Automatic self-heal for stuck deferred-tool resume loops.** `claude --continue` can land back inside a session with a stale deferred-tool marker and then log `No deferred tool marker found in the resumed session` or `Input must be provided either through stdin or as a prompt argument when using --print` hundreds of times without crashing, so `StartLimitBurst` never fires and manual intervention was the only exit. `/agent:service install` now ships three layered defenses by default: (1) the resume wrapper gains a pre-flight that honors a `~/.clawcode/service/<slug>.force-fresh` flag and inspects the tail of the service log for the error pattern, skipping `--continue` when the rate exceeds threshold; (2) a new heal sidecar (`clawcode-heal-<slug>.timer` + `.service` on Linux, `com.clawcode.heal.<slug>.plist` on macOS) fires every 60 s, writes the force-fresh flag, and restarts the main service when the pattern trips, observing a 10-minute cooldown between bounces; (3) `StartLimitBurst` tightened from 5 to 3 since the slow-spam failure mode is now Layer 2's job. All three are on by default. Opt out with `service_plan({ action: "install", selfHeal: false })` if an external watchdog (`recipes/watchdog/`) handles recovery. New exported constants `HEAL_PATTERN` / `HEAL_THRESHOLD` / `HEAL_WINDOW_SECONDS` / `HEAL_LOG_TAIL_LINES` are the single source of truth for both layers. First failure mode observed in production by [@JD2005L](https://github.com/JD2005L) on 2026-04-17 (log flood of 22 "deferred tool marker" errors followed by 7 "input must be provided" errors, with `pkill` permission failures preventing self-recovery). Reported by [@JD2005L](https://github.com/JD2005L) in [#19](https://github.com/crisandrews/ClawCode/pull/19) / [#21](https://github.com/crisandrews/ClawCode/pull/21).
- **`npm test`.** New smoke test at `tests/service-generator-smoke.test.ts` runs `bash -n` on every generated shell script, asserts the plan shape for install / uninstall across both platforms, and exercises the wrapper pre-flight + heal sidecar against a synthetic log flood. 18 checks, ~1 second, zero external deps. Tracked publicly via a refined `.gitignore` pattern (`tests/*` + `!tests/*.test.ts`) so future template-interpolation bugs surface at the maintainer's machine before landing on a user's system.
- **`resumeOnRestart` and `selfHeal` now exposed on `service_plan`.** Previously `resumeOnRestart` lived only in the library layer. Both knobs are now part of the MCP tool schema so they're discoverable and opt-outable without dropping into TypeScript.

### Fixed

- **`jq` visible to cron hooks when installed user-local.** `hooks/cron-posttool.sh`, `hooks/reconcile-crons.sh`, and `skills/crons/writeback.sh` now prepend `$HOME/.local/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin` to their PATH. Needed when the hook runs under systemd user service / launchd LaunchAgent, where the inherited PATH is minimal and skips Homebrew / pip-user install dirs; without this, `command -v jq` returns empty and the hook silently drops to degraded mode. No effect on interactive sessions where the shell's PATH already exposes `jq`. Reported by [@JD2005L](https://github.com/JD2005L) in [#20](https://github.com/crisandrews/ClawCode/pull/20).

## [1.4.0] — 2026-04-17

### Thanks

- **[@JD2005L](https://github.com/JD2005L)** for eight PRs in a single push, all from running ClawCode 24/7 as a systemd service: the WORKSPACE resolution fix, the service crash-loop PTY wrap, resume-on-restart, service hardening defaults, the `/agent:update` skill + heartbeat version-check, cross-user import discovery, the reconcile fast-path, and the follow-up `DISABLE_AUTOUPDATER` rationale that corrected a review miss on our side. This release is largely JD's work.

### Added

- **Resume-on-restart wrapper.** `/agent:service install` now generates `~/.clawcode/service/<slug>-resume-wrapper.sh` and points the systemd unit / launchd plist at it. The wrapper runs `claude --continue` so a service restart rehydrates the prior conversation instead of starting fresh. Falls back to a plain start on first boot (no prior session jsonl) or when the last session is more than 7 days old. Opt-out via `service_plan({ action: "install", resumeOnRestart: false })`. Cross-platform (GNU `stat -c %Y` with BSD `stat -f %m` fallback). Reported by [@JD2005L](https://github.com/JD2005L) in [#7](https://github.com/crisandrews/ClawCode/pull/7).
- **Service hardening defaults.** `generateSystemdUnit` now emits `Environment=HOME=...`, `Environment=TERM=xterm-256color`, and a `StartLimitIntervalSec=300` / `StartLimitBurst=5` crash-loop guard so a deterministic boot-time error surfaces in `systemctl status` instead of churning forever in journald. `generatePlist` emits an `EnvironmentVariables` dict with HOME and TERM. Default log path moved from `/tmp/clawcode-<slug>.log` (wiped on reboot) to `~/.clawcode/logs/<slug>.log`, with the install plan creating the directory up front since neither `append:` nor `StandardOutPath` create missing parents. Reported by [@JD2005L](https://github.com/JD2005L) in [#8](https://github.com/crisandrews/ClawCode/pull/8).
- **`/agent:update` skill + heartbeat version check.** New user-invocable skill that detects installed vs. available versions of Claude Code (`npm view`) and ClawCode (`git describe --tags upstream/main` — tag-based, not HEAD, so routine upstream commits do not generate notification noise) and prints the safe update commands. Never applies updates itself — detect-and-report only, intentional for daemon mode. Heartbeat gains an "Update check" bullet that fires once per UTC day with per-version dedupe via `memory/.notified-versions.json`, so each new version is announced exactly once. Skill gracefully handles no-network, missing `upstream` remote, and non-git-checkout installs. Template-only change for new agents — existing `HEARTBEAT.md` files are unaffected. Reported by [@JD2005L](https://github.com/JD2005L) in [#12](https://github.com/crisandrews/ClawCode/pull/12).

### Fixed

- **`memory_search` and every other MCP tool that reads `WORKSPACE` now resolves to the user's project dir, not the plugin dir.** `server.ts` used `process.cwd()` for `WORKSPACE`, but `.mcp.json` runs the server with `cd "${CLAUDE_PLUGIN_ROOT}" && exec …`, which silently clobbered the agent's real workspace. Identity injection via hooks was unaffected (hooks already use `${CLAUDE_PROJECT_DIR:-$PWD}`), so the agent felt wired up correctly while memory silently read from the plugin's bundled `memory/` folder. Fix: three-step fallback `CLAUDE_PROJECT_DIR || OLDPWD || process.cwd()`, mirroring the hooks. Closes [#5](https://github.com/crisandrews/ClawCode/issues/5). Reported by [@JD2005L](https://github.com/JD2005L) in [#6](https://github.com/crisandrews/ClawCode/pull/6).
- **Service crash loop on Linux systemd after Claude Code auto-updates mid-run.** When the in-process auto-updater regenerates wrapper scripts while the daemon is running, the resulting invocation runs without a PTY; on the next graceful shutdown the `SessionEnd` hook cannot spawn `/bin/sh`, exits non-zero, and `Restart=on-failure` produces a permanent loop. Fix: wrap `ExecStart` in `/usr/bin/script -q -c '...' /dev/null` so `claude` always has a PTY from the outside, and set `Environment=DISABLE_AUTOUPDATER=1` so the auto-updater cannot regenerate daemon-relevant files mid-run (a file-integrity issue distinct from the PTY crash-loop). Together the two are addressing different failure modes — the PTY wrap covers graceful shutdown, the env var covers version skew between the in-memory process and on-disk binary while the daemon runs. Reported by [@JD2005L](https://github.com/JD2005L) in [#9](https://github.com/crisandrews/ClawCode/pull/9) and clarified via [#17](https://github.com/crisandrews/ClawCode/pull/17) / [#18](https://github.com/crisandrews/ClawCode/pull/18) after an interim removal in #16 proved premature.
- **Service PTY parity on macOS launchd.** `generatePlist` now wraps the invocation in `/usr/bin/script -q /dev/null <claudeBin> <args>` (BSD syntax). launchd services run without a controlling TTY by default, same shape as systemd, so the SessionEnd-hook failure mode fixed on Linux in #9 could in principle hit Mac. Applies the same protection mechanism. [#16](https://github.com/crisandrews/ClawCode/pull/16).
- **Cross-user `/agent:import` discovery.** The import skill looked only under `~/.openclaw/workspace*`, which missed the common container case where OpenClaw ran as `root` and ClawCode runs as a non-root service user. New discovery loop unions readable `$CLAWCODE_OPENCLAW_ROOT`, `$HOME/.openclaw`, and `/root/.openclaw`, silently skipping unreadable roots so the user never sees permission-denied spam. A new Step G in the import flow also scans `~/.claude/settings.json`, `~/.claude/installed_plugins.json`, and `./agent-config.json` for absolute paths pointing at a different user's home directory — when the runtime user switches, those paths become unreachable and skills fail with "unknown skill". ClawCode does not own these files, so Step G is detect-and-warn only (prints a ready-to-run `sed` command); the user decides whether to apply. Reported by [@JD2005L](https://github.com/JD2005L) in [#10](https://github.com/crisandrews/ClawCode/pull/10).

### Performance

- **`hooks/reconcile-crons.sh` fast-path on steady-state sessions.** Every `SessionStart` previously emitted a `ToolSearch` + `CronList` + `CronCreate` envelope to verify that every cron in `memory/crons.json` was live in the harness — a few hundred milliseconds of blocking tool calls for a check that only has real work to do on the first session after install or after external drift. The hook now exits 0 immediately when (a) no migration is pending and (b) every active entry already has a populated `harnessTaskId`. First boot, upgrades from older versions, external `CronDelete` captured by writeback, and corrupt `crons.json` all fall through to the existing envelope path, so the behavior is unchanged in every case that actually needs reconciliation. Worst-case drift is bounded at 30 min by the heartbeat skill's reconcile step — which is tighter than the status quo for workspaces that do not session-start often. Reported by [@JD2005L](https://github.com/JD2005L) in [#11](https://github.com/crisandrews/ClawCode/pull/11).

### Documentation

- `docs/service.md` — updated example systemd unit and launchd plist to reflect the new defaults (`HOME`/`TERM` env, crash-loop guard, persistent log path). Logs section rewritten to describe the new path and explain why the log directory is created at install. Troubleshooting row for restart loops now points at `~/.clawcode/logs/<slug>.log` and mentions `StartLimitBurst=5`. New "Resume-on-restart wrapper" section explaining the default behavior, 7-day stale-session fallback, and the opt-out.
- `docs/autoresearch.md`, `docs/task-guard.md` — *not in this release.* PRs #13 and #14 are deferred to a future session.
- `skills/import/SKILL.md` — discovery loop + Step G "Path sanity check" documented inline, with fix-ready `sed` suggestions.
- `skills/update/SKILL.md` — new user-invocable skill, with permission caveats (root-owned `node_modules/`, need for operator to run the install command) and channel-specific formatting notes (WhatsApp `*bold*` vs. Telegram markdown).
- `templates/HEARTBEAT.md` — new "Update check" bullet with day-gate and per-version dedupe.

## [1.3.0] — 2026-04-15

### Thanks

- **[@JD2005L](https://github.com/JD2005L)** for the thorough write-up in [#4](https://github.com/crisandrews/ClawCode/issues/4) — 13 friction points from running ClawCode 24/7 as a systemd service with Telegram on Debian LXC. This release addresses 7 of them directly (item 1 TTY bypass-dialog hang, item 6 multi-instance race on restart, item 10 config-edit MCP drop, item 11 stale plugin paths after user switch, item 12 stale FTS index after import, plus item 5 groundwork via the new opt-in watchdog which is the testable answer to "plugin subprocess dies silently"). Items deferred to future iterations are parked in `ideas/`.

### Fixed
- `memory_search` now picks up files added or edited during a session. Previously the FTS index was only re-synced on the first search after MCP startup or via `/agent:doctor --fix` — files added mid-session (e.g. by `/agent:import` while a session was running, or new WhatsApp / Telegram conversation logs landing under an `extraPaths` directory) stayed invisible until restart. Root cause: the `dirty` flag in `MemoryDB` was initialized to `true` (so the first search synced) but `markDirty()` had no external callers, so subsequent file changes never triggered a re-sync. Fix: the `MemoryDB` constructor now sets up an `fs.watch` on `memory/` (top-level) and on each entry in `memory.extraPaths` (recursive on macOS / Windows; top-level only on Linux due to a Node `fs.watch` limitation). Any `.md` create / edit / rename / delete marks the index dirty so the next search re-syncs. Best-effort with a `try/catch` fallback per watcher — if a watcher cannot be created (missing path, NFS, watcher limits), the existing dirty-on-startup behavior + `/agent:doctor --fix` still cover the user. Reported by [@JD2005L](https://github.com/JD2005L) in [#4](https://github.com/crisandrews/ClawCode/issues/4) item 12; the user's stated symptom ("only `MEMORY.md` indexed after import") was an indirect effect of this bug.

### Added
- `/agent:service install` now pre-checks `~/.claude/settings.json` before writing any service files. If `skipDangerousModePermissionPrompt: true` is missing, the skill explains the consequence (silent hang at startup with no TTY to answer the bypass dialog) and offers to add it via a `jq`-based atomic merge that preserves any existing keys. Decline once and the skill warns; decline twice and install aborts cleanly without touching launchd / systemd. Cross-platform: same fix applies to macOS launchd and Linux systemd because the file is `~/.claude/settings.json` on both.
- **Watchdog (optional)**: new `recipes/watchdog/` folder with an opt-in external health probe for always-on services. A short-lived `watcher.sh` runs every 5 min (via systemd user timer on Linux or launchd `StartInterval` on macOS) and performs up to **5 tiered checks** — service-manager status, HTTP bridge `/health`, new ClawCode `/watchdog/mcp-ping` endpoint, scoped `pgrep -P <main-pid>` against expected channel plugins, and new `/watchdog/llm-ping` which injects a `__watchdog_ping__ PONG-<nonce>` message and polls chat history for the agent's echo to verify the LLM is responding end-to-end. First failing tier short-circuits and triggers `--on-fail` (default: restart) plus optional `--alert-cmd` (Telegram Bot API helper + generic template shipped). New `watchdog_ping` MCP tool and both HTTP routes refuse non-loopback requests regardless of `http.host` (belt-and-suspenders middleware) and inherit the bridge's token auth. Tier 5 LLM ping additionally requires `http.token` (token-drain protection) and is rate-limited to 1/hour per token; watcher also guards with its own `--llm-ping-interval` (default 3600s). Installers auto-detect label / port / token / installed plugins; typical install asks zero or one question. Does not touch the running service during install. Full docs: [`docs/watchdog.md`](docs/watchdog.md). Reported by [@JD2005L](https://github.com/JD2005L) in [#4 item 5](https://github.com/crisandrews/ClawCode/issues/4).
- **Public helper** `isLoopbackAddress(addr: string | undefined): boolean` exported from `lib/http-bridge.ts`. Pure classifier used internally by `/watchdog/*` routes to refuse non-loopback peers (covers IPv4, IPv6, IPv4-mapped-IPv6). External code may consume it; small surface, no runtime behavior change vs. prior inline version.
- `lib/service-generator.ts` now emits `ExecStartPre=-/usr/bin/pkill -f "claude.*--dangerously-skip-permissions"` in the systemd unit on Linux. Prevents the multi-instance race condition where a restart leaves the old `claude` briefly alive next to the new one and both connect to the same channel, fighting for incoming messages. The `-f` filter only matches service-mode invocations, so an interactive `claude` session in another terminal is left alone. macOS plist is unchanged — launchd already guarantees single-instance per Label. Existing installs do not benefit automatically; reinstall (`/agent:service uninstall` + `/agent:service install`) to regenerate the unit. Reported by [@JD2005L](https://github.com/JD2005L) in [#4](https://github.com/crisandrews/ClawCode/issues/4).

### Documentation
- `docs/service.md` — added a "Heads-up" note inside the safety trade-off section and a troubleshooting row explaining that `--dangerously-skip-permissions` alone is not enough under launchd / systemd: bypass mode shows an interactive `WARNING: Bypass Permissions mode — Do you accept?` dialog at startup that a daemon has no TTY to answer, so the service hangs silently before reaching the listening state. Fix: persist `"skipDangerousModePermissionPrompt": true` in `~/.claude/settings.json` before installing the service. Tracked upstream as [anthropics/claude-code#25503](https://github.com/anthropics/claude-code/issues/25503). Only affects service mode; interactive `claude` is unaffected.
- `docs/service.md` — troubleshooting row noting that editing `~/.claude/settings.json` while the service runs reloads MCPs and some plugins (Telegram observed) do not reconnect, leaving the service "active" but dropping messages. Fix: restart the service after any manual edit. Reported by [@JD2005L](https://github.com/JD2005L) in [#4](https://github.com/crisandrews/ClawCode/issues/4).
- `docs/doctor.md` — added "Issues NOT auto-fixed" entry for "unknown skill" errors caused by stale plugin paths in `~/.claude/plugins/installed_plugins.json` after a runtime user change. The file is Claude Code internal (ClawCode does not own it), so doctor cannot safely auto-rewrite. Documented manual `jq` fix (validated by [@JD2005L](https://github.com/JD2005L) in [#4](https://github.com/crisandrews/ClawCode/issues/4)).
- `docs/watchdog.md` — new full user guide for the optional watchdog recipe.
- `docs/INDEX.md` — watchdog row added under "Optional".
- `docs/memory.md` — rewrote the three lines that claimed "re-syncs on next search" to reflect the actual behavior after the `fs.watch` fix; added a paragraph to the `extraPaths` section about the Linux recursive-watch caveat.
- `README.md` — mascot image added above the title; watchdog link added after the always-on-service section.
- `assets/clawcode.png` (new) — mascot artwork used by the README.

## [1.2.2] — 2026-04-13

### Thanks
- @JD2005L for reporting [#1](https://github.com/crisandrews/ClawCode/issues/1) — the investigation into your report surfaced a bug that affected every user silently. Fix below.

### Fixed (GitHub issue #1)
- **Reminders now persist across session closes.** Previously the SessionStart hook relied on a `.crons-created` marker that persisted on disk while the crons themselves died with the session, so heartbeat / dreaming / imported / ad-hoc crons silently disappeared after every restart. The new system keeps a registry at `memory/crons.json` and reconciles it against the live harness on every SessionStart — anything missing is recreated, anything live-but-unknown is adopted.
- **Ad-hoc reminders ("remind me in 4 hours to X") survive restarts.** A PostToolUse hook captures every `CronCreate` call and writes it to the registry; next session, reconcile recreates it.
- **User deletions stay deleted.** `CronDelete` tombstones the registry entry; reconcile skips it.

### Added
- `/agent:crons` skill extended with subcommand dispatcher: `list`, `add`, `delete`, `pause`, `resume`, `reconcile`, plus existing `import`. Aliases: `/agent:reminders`, "list reminders", "show crons", "recordatorios", "mis crons".
- `skills/crons/writeback.sh` — single writer for `memory/crons.json`. Subcommands: `seed-defaults`, `upsert`, `tombstone`, `set-alive`, `adopt-unknown`, `pause`, `resume`, `migration-mark`. Lockfile-protected, atomic-write.
- `hooks/reconcile-crons.sh` — SessionStart hook. Seeds defaults, detects migration need, emits a deterministic reconcile envelope for the agent to execute. Degraded-mode fallback if `jq` is missing.
- `hooks/cron-posttool.sh` — PostToolUse hook on `CronCreate`/`CronDelete`. Captures ad-hoc crons; tombstones on delete. Idempotent via `harnessTaskId` key. Suppressed during reconcile via `memory/.reconciling` marker.
- Migration flow for upgraders who had OpenClaw imports: SessionStart detects `IMPORT_BACKLOG.md` + `~/.openclaw/cron/jobs.json` and offers re-import via native `AskUserQuestion` (Sí / Después / No nunca). Answer persisted in `migration.openclawAnsweredAt`; auto-flagged if user runs `/agent:crons import` manually.
- `docs/crons.md` — user-facing documentation: registry schema, commands, harness assumptions, failure modes.
- Doctor adds two checks: `cron-registry` (parseable + stale tombstone count) and `jq` (presence).
- Tests: `tier1m-cron-registry.sh` (18 unit tests for writeback), `tier2q-reconcile-hook.sh` (10 integration tests for reconcile hook), `tier2r-cron-posttool.sh` (10 integration tests for posttool hook), plus `tests/stubs/Cron{Create,List,Delete}.sh` fakes.

### Removed
- Inline "MANDATORY ACTION REQUIRED" bash block in SessionStart hook — replaced with a single `bash ${CLAUDE_PLUGIN_ROOT}/hooks/reconcile-crons.sh` invocation.
- `server.ts` bootstrap context's inline `CronCreate(..., durable=true)` instructions — replaced with a short reference to the reconcile flow.
- `skills/import/SKILL.md` Step B no longer tells the agent to call CronCreate directly — delegates to `writeback.sh seed-defaults`.
- Legacy `.crons-created` marker at workspace root is now cleaned up automatically by reconcile-crons.sh on first run (kept in `.gitignore` so users mid-upgrade don't accidentally commit it).

## [1.2.1] — 2026-04-13

### Security
- Token is now **required** when HTTP bridge binds to non-localhost (`host != 127.0.0.1`). Bridge refuses to start without one.
- WebChat HTML now requires auth when token is configured (was served without auth before).

### Added
- Webhook tutorials: Cloudflare Email Worker catch-all, Gmail push via Pub/Sub (full code + setup steps)
- Webhook use cases linked from README to detailed docs
- Self-managing heartbeat: agent edits `HEARTBEAT.md` with initiative during conversations
- Lightweight `HEARTBEAT.md` template (5 lines, not 50)
- Heartbeat state tracking via `memory/heartbeat-state.json`
- Plugin update workaround in README (manual method when `/plugin update` says "already at latest")

### Fixed
- Heartbeat template was too heavy — moved behavioral rules to AGENTS.md and skill, kept only the checklist in HEARTBEAT.md

## [1.2.0] — 2026-04-13

### Fixed
- Silent `npm install` failure — errors are now visible instead of "Failed to reconnect" with no explanation
- Dependencies only install if not already present (faster subsequent sessions)

### Added
- Cron persistence limitation documented in troubleshooting

## [1.1.0] — 2026-04-12

### Added
- Active memory with bilingual recall (ES ↔ EN, 40+ synonym pairs)
- Date expansion in memory queries ("hoy" → today's date)
- Voice TTS/STT (sag, ElevenLabs, OpenAI, macOS say, Whisper)
- WebChat browser UI with SSE real-time delivery
- Conversation logging in JSONL + Markdown (same format as WhatsApp plugin)
- HTTP bridge with status/skills/webhook/chat endpoints
- Live config — non-critical settings apply without `/mcp`
- Channel detector + launch command builder
- Command discovery (dynamic `/help`)
- `/doctor` diagnostics with `--fix` auto-repair
- Skill manager — install from GitHub with `owner/repo@branch#subdir`
- Service manager (launchd/systemd)
- AskUserQuestion wizard for import/create flows
- Clean imports — no file annotations, all notes go to IMPORT_BACKLOG.md
- Terse agent behavior by default
- Lifecycle hooks documented (SessionStart, PreCompact, Stop, SessionEnd)
- Language adaptation — responds in user's language

### Fixed
- `CronCreate` parameter is `cron`, not `schedule`
- `CronCreate` is a deferred tool — needs `ToolSearch` first
- Bilingual memory recall: `recencyBoost` was passing `ageDays` instead of `filePath`
- FTS5 query changed from AND to OR (improves cross-language recall)

## [1.0.0] — 2026-04-09

### Added
- Initial release
- Persistent identity (SOUL.md, IDENTITY.md, USER.md)
- Memory system (SQLite + FTS5, temporal decay, MMR)
- QMD optional backend (local embeddings)
- Dreaming (3-phase: Light, REM, Deep with 6 weighted signals)
- Heartbeat (30-min periodic checks)
- Bootstrap ritual (conversational onboarding)
- Import from existing agent workspaces
- Skills: create, import, crons, heartbeat, settings, messaging, status, usage, new, compact, help, whoami
- Hooks: SessionStart, PreCompact, Stop, SessionEnd
- Messaging channel support (WhatsApp, Telegram, Discord, iMessage, Slack)
