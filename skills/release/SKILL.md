---
name: release
description: Cut a new release of the ClawCode plugin itself — bump version in plugin.json + package.json, move CHANGELOG [Unreleased] to [X.Y.Z], commit, push to main, AND create the GitHub release with grouped notes. For ClawCode plugin maintainers only (not for end users of the agent). Triggers on /agent:release, "cut a release", "release new version", "ship vX.Y.Z", "publish vX.Y.Z", "bump version".
user-invocable: true
---

# Release flow for the ClawCode plugin

This skill is for cutting a new version of the ClawCode plugin itself (the repo at `crisandrews/ClawCode`). Run it after pushing a feature/fix to `main` that warrants a user-visible release.

**End users of an agent (Cloudy, Wally, etc.) should not invoke this skill** — it modifies the plugin source repo, not the agent's workspace. The skill only does anything useful when the working directory is the ClawCode plugin repo.

## ⛔ Why this skill exists

I (the agent maintaining the plugin) have repeatedly forgotten step 4 (the GitHub Release) when shipping a new version. The version went into `plugin.json` and got committed, but no `vX.Y.Z` release appeared on https://github.com/crisandrews/ClawCode/releases. End users had no canonical place to read release notes or be notified. JC flagged it as a recurring miss on 2026-04-19. This skill exists to make it impossible to skip step 4.

## The 4 mandatory steps

ALL FOUR must complete. Stop and report failure if any step errors out — never partially release.

### Step 1 — Bump versions in BOTH manifests

The single source of truth for Claude Code is `.claude-plugin/plugin.json`, but `package.json` must stay in sync (otherwise npm tooling and `package.json`-aware scripts go stale).

```bash
# Verify current version
jq -r .version .claude-plugin/plugin.json
jq -r .version package.json
# Both should match. If they don't, fix the drift FIRST.
```

Decide the bump type:
- **patch** (X.Y.Z → X.Y.Z+1): bug fixes, docs, metadata, small additions that don't change behavior
- **minor** (X.Y.Z → X.Y+1.0): new features, new commands, new skills
- **major** (X.Y.Z → X+1.0.0): breaking changes (renamed/removed config, incompatible behavior shift)

If unclear, use `AskUserQuestion` to confirm with the maintainer before proceeding.

Edit both files:
```bash
# Both edits must succeed. Use Edit tool, not sed/awk.
# .claude-plugin/plugin.json: bump "version": "<old>" → "<new>"
# package.json: same
```

### Step 2 — Move CHANGELOG `[Unreleased]` block to `[X.Y.Z]`

`CHANGELOG.md` always has an `## [Unreleased]` block at the top where in-flight changes accumulate. On release, that block becomes the new version's notes.

```markdown
# Changelog

## [Unreleased]                      ← stays empty after the move

## [X.Y.Z] — YYYY-MM-DD               ← what was [Unreleased] becomes this
### Fixed / Added / Changed / ...
- ...
```

Use today's date in `YYYY-MM-DD` format. The `[Unreleased]` heading itself stays as a placeholder for the next release.

If `[Unreleased]` is empty, STOP and ask the maintainer what should go in the release notes — never publish a release without notes.

### Step 3 — Commit + push

```bash
git add .claude-plugin/plugin.json package.json CHANGELOG.md [+ any other modified files]
git commit -m "$(cat <<'EOF'
<type>(<scope>): <short summary>; bump to X.Y.Z

<longer body explaining what changed and why, mirroring the CHANGELOG entry.
Don't repeat the entire entry verbatim — summarize the user-visible change.>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

Conventional commit prefixes seen in this repo: `fix(scope)`, `chore(scope)`, `feat(scope)`, `docs(scope)`. Pick the one that matches the dominant change in the release.

### Step 4 — Create the GitHub Release (this is the one I keep forgetting)

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z — <short user-facing description>" \
  --notes "$(cat <<'EOF'
### Fixed   ← or Added / Changed / etc., grouped exactly like the CHANGELOG entry

- One concise bullet per user-visible change. Conversational tone, not formal. See `feedback_release_notes_style.md` memory.

Full changelog: [CHANGELOG.md](https://github.com/crisandrews/ClawCode/blob/main/CHANGELOG.md#xyz--yyyy-mm-dd).
EOF
)"
```

Verify the release URL was returned (`https://github.com/crisandrews/ClawCode/releases/tag/vX.Y.Z`). Report it to the user.

Title style (see existing releases):
- `vX.Y.Z — Short user-facing description` (em-dash `—`, not hyphen)
- Examples: `v1.4.4 — Plugin hook load fix`, `v1.4.5 — Reminders persist across /exit on Claude Code v2.1.114`, `v1.4.6 — Plugin metadata for /plugin viewer (repo link)`

Body style:
- Brief intro grouped by `### Fixed` / `### Added` / `### Changed` headers
- One bullet per change, conversational, points at the human-impact outcome
- Don't reproduce the full CHANGELOG entry — link to it
- See `feedback_release_notes_style.md` memory for full guidance

## Self-check after publishing

```bash
gh release view vX.Y.Z --json tagName,name,url | jq .
gh release list --limit 3
```

The new release should appear at the top with the `Latest` badge.

## Common pitfalls

- **Skipping step 4**: the version exists in code but no release on GitHub. Users don't get notified. THIS IS THE BUG THIS SKILL FIXES.
- **Bumping only `package.json`**: `/plugin update` reports "already at latest" because Claude Code reads `plugin.json` only. See `project_plugin_versioning.md` memory.
- **Empty `[Unreleased]`**: never publish a release without notes. Stop and ask.
- **Inconsistent date**: use today's local date in `YYYY-MM-DD` (run `date +%Y-%m-%d` to be sure).
- **Forgetting to push before `gh release create`**: `gh release create` tags the LATEST pushed commit. If you didn't push step 3 first, the release tag points at a stale SHA. Always push before releasing.

## Related skills / memories

- `feedback_never_commit_push_without_ask.md` — git push requires explicit per-action approval. This skill documents the WHAT; the maintainer authorizes the WHEN.
- `feedback_release_notes_style.md` — release body conventions.
- `project_plugin_versioning.md` — why `plugin.json` is the source of truth.
