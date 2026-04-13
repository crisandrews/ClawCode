---
name: import
description: Import an existing OpenClaw agent from its workspace directory into the current project. Triggers on /agent:import, "importar agente", "traer de openclaw", "import agent".
user-invocable: true
argument-hint: [agent-id]
---

# Import an OpenClaw Agent

Import an existing agent from an OpenClaw installation into this directory, then offer the same setup steps a new agent gets (QMD, messaging, crons).

## Part 1: Copy the agent

1. **List available OpenClaw agents**:
   ```bash
   ls -d ~/.openclaw/workspace* 2>/dev/null
   ```
   
   For each workspace, read IDENTITY.md to show the agent's name:
   - `~/.openclaw/workspace/` — default agent (main)
   - `~/.openclaw/workspace-eva/` — agent "eva"
   - `~/.openclaw/workspace-jack/` — agent "jack"

2. **Let the user choose** which agent to import (or use argument if provided).

3. **Determine the source path**:
   - Default/main: `~/.openclaw/workspace/`
   - Named agent: `~/.openclaw/workspace-{id}/`

4. **Copy bootstrap files** to the current project root:
   Files to copy from the source workspace:
   - `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`
   
   Also copy CLAUDE.md from the plugin templates (NOT from OpenClaw):
   ```bash
   cp ${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.md ./
   ```

5. **Import memory** (ask user first):
   - Copy `MEMORY.md` to `./memory/MEMORY.md`
   - Copy recent memory files from `memory/` (last 30 days by default, or all if user wants full history)
   - Create `./memory/.dreams/` directory with empty `short-term-recall.json`
   - **NEVER copy** files with `credential`, `password`, `secret`, `.env` in their name

6. **Adapt AGENTS.md** for Claude Code:
   After copying, remove or comment out sections referencing OpenClaw-specific tools:
   - `sessions_spawn`, `message tool`, `browser tool`
   - `gateway`, `cron tool` (native OpenClaw cron), OpenClaw CLI commands
   - `HEARTBEAT_OK`, `NO_REPLY`, `ANNOUNCE_SKIP`, `SILENT_REPLY_TOKEN`
   
   **Keep**: safety rules, behavioral rules, memory protocols, learning rules, personal conventions.

## Part 2: Post-import setup (offer the same as /agent:create)

After the files are copied, the imported agent is functional but not fully configured. Offer the same setup steps a new agent gets, so imported agents end up with full parity.

### Step A — Memory backend (QMD vs builtin)

Check if QMD is installed: `qmd --version 2>/dev/null`

Use `AskUserQuestion` to present the choice (do NOT dump this with other questions):

```
AskUserQuestion(
  question: "Memory backend for this agent?",
  options: [
    { label: "QMD (semantic search)", description: "Local embeddings, reranking. Best quality. Requires qmd installed." },
    { label: "Builtin (SQLite + FTS5)", description: "Full-text search with BM25. Works out of the box." }
  ]
)
```

If QMD is not installed, skip the question and auto-select builtin — just inform the user: "Using builtin memory (QMD not detected). Install later with `bun install -g qmd`."

Write `agent-config.json` based on the choice:
- QMD: `{ "memory": { "backend": "qmd", "citations": "auto", "qmd": { "searchMode": "vsearch", "includeDefaultMemory": true, "limits": { "maxResults": 6, "timeoutMs": 15000 } } } }`
- Builtin: `{ "memory": { "backend": "builtin", "citations": "auto", "builtin": { "temporalDecay": true, "halfLifeDays": 30, "mmr": true, "mmrLambda": 0.7 } } }`

**Wait for the user's answer before proceeding to Step B.**

### Step B — Seed default crons into the registry

The SessionStart reconcile flow handles default crons automatically via the registry at `memory/crons.json`. During onboarding, just call `writeback.sh seed-defaults` to bootstrap it:

```bash
bash "$CLAUDE_PLUGIN_ROOT/skills/crons/writeback.sh" seed-defaults
```

This creates registry entries for `heartbeat-default` (*/30 * * * *) and `dreaming-default` (0 3 * * *) if missing; idempotent if already present. The next SessionStart (or a manual `/agent:crons reconcile`) will call `CronCreate` to realize them in the harness.

**Do NOT** create `touch .crons-created` — that marker is obsolete, cleaned up by reconcile.

**Do NOT** call `CronCreate` directly for defaults during import — the reconcile flow handles it and avoids PostToolUse duplicate-capture races.

### Step C — Import the agent's skills (interactive)

The OpenClaw agent likely has skills it relied on (Wally has 44, Eva has 20+, etc.). Offer to import them, letting the user pick *all*, *some*, or *none*.

**C.1 — Discover.** List everything under the source workspace's `skills/` directory. For each subdirectory, read the first ~20 lines of `SKILL.md` to get the frontmatter `name` and `description`.

```bash
SRC_SKILLS="$SOURCE_WORKSPACE/skills"
test -d "$SRC_SKILLS" || { echo "No skills dir — skipping step C"; }
ALL_SKILLS=$(ls "$SRC_SKILLS" 2>/dev/null)
TOTAL=$(echo "$ALL_SKILLS" | wc -l | tr -d ' ')
```

**C.2 — Classify (silent pre-pass).** Run each skill's `SKILL.md` through the classifier:

```bash
HARD_RED='sessions_spawn|gateway config\.patch|http://192\.168\.|canvas\(|remindctl|wacli|openclaw gateway|HEARTBEAT_OK|NO_REPLY|peekaboo'
SOFT_YELLOW='sessions_send|message\(|~/\.openclaw/|\.openclaw/credentials'

classify_skill() {
  local file="$1"
  local hard soft
  hard=$(grep -cE "$HARD_RED" "$file" 2>/dev/null || true)
  [ -z "$hard" ] && hard=0
  soft=$(grep -cE "$SOFT_YELLOW" "$file" 2>/dev/null || true)
  [ -z "$soft" ] && soft=0
  if [ "$hard" -gt 0 ]; then echo "RED"
  elif [ "$soft" -gt 0 ]; then echo "YELLOW"
  else echo "GREEN"
  fi
}
# NOTE: don't use `|| echo 0` here — `grep -c` already prints 0 when empty,
# and `|| echo 0` would produce "0\n0" causing `[: integer expected` on bash 3.2.

```

For each skill, record: name, tier, matched tokens (for reason text), description (first line).

**C.3 — Present results and ask via `AskUserQuestion`.**

First, show a brief summary: "Found <TOTAL> skills: <G> green, <Y> yellow, <R> red."

Then use `AskUserQuestion` (one question at a time — do NOT combine with other steps):

```
AskUserQuestion(
  question: "Found <TOTAL> skills in <agent>'s workspace: <G> portable, <Y> need adaptation, <R> incompatible. What to do?",
  options: [
    { label: "Import all portable (<G+Y>)", description: "GREEN as-is, YELLOW with adaptation headers. RED skipped." },
    { label: "Let me pick specific ones", description: "I'll show the full list with tiers so you can choose." },
    { label: "Skip skills", description: "Don't import any skills for now." }
  ]
)
```

**Wait for the user's answer before proceeding.**

**C.4 — Handle the choice:**

- **"Import all portable"** → import all GREEN + YELLOW skills. Skip all RED.
- **"Let me pick"** → Show a numbered list of every skill with tier + reason. Then use a second `AskUserQuestion` or let the user type the numbers/names. If the user picks a RED skill, import it with a 🛑 header (see C.5).
- **"Skip skills"** → Skip step C entirely. Print `"Skills: skipped"` to the report.

**C.5 — Import each selected skill.** For each chosen skill:

**If GREEN**: Copy the entire directory verbatim — NO comments, NO headers, NO annotations:
```bash
mkdir -p "./skills/<name>"
cp -r "$SRC_SKILLS/<name>/." "./skills/<name>/"
```
The file should look identical to the source. Clean.

**If YELLOW**: Copy the directory verbatim — same as GREEN, NO headers in the file. Instead, record the adaptation notes in `IMPORT_BACKLOG.md` (Step C.8) so the file stays clean but the user knows what to review later.

**If RED (only if user explicitly selected)**: Copy verbatim. Record the incompatibility details in `IMPORT_BACKLOG.md`.

**IMPORTANT**: Never add comments, headers, or annotations inside imported files. They fill context unnecessarily and reference external systems. All adaptation notes go to `IMPORT_BACKLOG.md` — one centralized place, not scattered across files.

**C.6 — Append to AGENTS.md.** For every successfully imported skill (GREEN + YELLOW + any forced RED), append a row to a `## Local imported skills` section in `./AGENTS.md`. Create the section if it doesn't exist yet.

Trigger phrases come from parsing the skill's `description` frontmatter — extract the comma-separated clauses that look like trigger phrases (often after "Triggers on" or similar):

```markdown
## Local imported skills

When the user's message matches a trigger phrase below, read the corresponding
SKILL.md file in `./skills/` and follow its instructions:

- **first-principles** (`./skills/first-principles/SKILL.md`) — "think from first principles", "break down from scratch"
- **deep-profile** (`./skills/deep-profile/SKILL.md`) — "profile this person", "deep research on"
- **shopping** (`./skills/shopping/SKILL.md`) — "buy", "compare prices", "shopping list"
```

All entries look the same — no tier markers in AGENTS.md. Adaptation details live in `IMPORT_BACKLOG.md`.

**C.7 — Per-item summary.** Print to the user:

```
Skills imported (<G+Y>):
  ✅ first-principles (green)
  ✅ deep-profile (green)
  ⚠️  shopping (yellow — uses `~/.openclaw/` at lines 15, 89)
  ⚠️  wally-instagram (yellow — uses `message()` at line 42)
  ...

Skipped (<R>):
  ❌ fix-api-keys — depends on `gateway config.patch` (OpenClaw gateway)
  ❌ control-center — depends on `http://192.168.3.102:3123` HTTP API
  ❌ reminders — depends on `remindctl` and `canvas()`
  ...
```

Every skipped item has a concrete *why*, not just a tier label.

**C.8 — Record skipped skills in the backlog.** For every RED skill that was NOT imported (and every YELLOW one the user *didn't* select during `[s]`), append an entry to `./IMPORT_BACKLOG.md`. Create the file if it doesn't exist yet. Entry format:

```markdown
### fix-api-keys
- **Original path**: `~/.openclaw/workspace/skills/fix-api-keys/`
- **Reason**: Depends on `gateway config.patch` (OpenClaw gateway) — no Claude Code equivalent
- **Original description**: <first line of description frontmatter>
- **Recovery notes**: The gateway is OpenClaw's runtime config system. To port: rewrite the skill to use environment variables or a config file managed via `/agent:settings`.
```

Group the entries under `## Skills — Skipped` and create the file header if it's the first entry (see format at the bottom of this skill).

### Step D — Import the agent's user crons (interactive)

OpenClaw agents often have dozens of scheduled crons. Offer to import them with the same interactive flow as skills.

**D.1 — Discover.** Read `~/.openclaw/cron/jobs.json`. The file has the shape `{"version": 1, "jobs": [...]}` — you must access `data["jobs"]`, not iterate `data` directly. Filter by the imported agent's `agentId` (for the default workspace it's usually `"main"`; for `workspace-eva/` it's `"eva"`; etc.). Skip jobs where `enabled: false`.

```bash
python3 -c "
import json
with open('$HOME/.openclaw/cron/jobs.json') as f: data = json.load(f)
jobs = [j for j in data['jobs'] if j.get('agentId') == '$AGENT_ID' and j.get('enabled')]
print(len(jobs))
for j in jobs:
    print(j['id'], '|', j.get('name'), '|', j['schedule'].get('kind'), '|', j['schedule'].get('expr'))
"
```

**D.2 — Classify:**

- 🟢 GREEN: `enabled: true`, `kind: cron`, `payload.kind: agentTurn`, payload message does NOT match HARD_RED regex, AND (no `delivery.channel` OR the channel's plugin is already installed — check `ls ~/.claude/plugins/cache/ 2>/dev/null | grep -i <channel>`)
- 🟡 YELLOW: `kind: at` with future timestamp, OR `kind: every` (convertible to `*/N`), OR `delivery.channel` references a plugin not yet installed, OR payload message matches SOFT_YELLOW regex
- 🔴 RED: `kind: at` with expired timestamp (`expr==null` and no future triggering), OR `kind: systemEvent`, OR payload message matches HARD_RED regex

For each classified cron, also record the *specific reason* (matched token name, schedule kind problem, channel problem).

**D.3 — Present results and ask via `AskUserQuestion`.**

Show brief summary, then use `AskUserQuestion`:

```
AskUserQuestion(
  question: "<agent> has <N> enabled crons: <G> portable, <Y> need adaptation, <R> incompatible. What to do?",
  options: [
    { label: "Import all portable (<G+Y>)", description: "GREEN as-is, YELLOW with adapted prompts. RED skipped." },
    { label: "Let me pick specific ones", description: "I'll show the full list with schedules and tiers." },
    { label: "Skip crons", description: "Don't import user crons. Default heartbeat + dreaming already set up." }
  ]
)
```

**Wait for the user's answer before proceeding.**

**D.4 — Handle the choice.** If "Let me pick", show numbered list:
```
#   Tier  Name                     Schedule                  Reason
1   🟢    Ideas Check-in           0 14 * * 3,6              OK
2   🔴    eva-sync-systemEvent     every 5min                kind:systemEvent — no equivalent
3   🟡    meditation               0 2 * * *                 channel=whatsapp (fallback to memory)
```

**D.5 — Import each selected cron.** Before the batch, suppress PostToolUse capture so entries get the correct `openclaw-<uuid>` key and `source: openclaw-import`:

```bash
touch "$CLAUDE_PROJECT_DIR/memory/.reconciling"
trap 'rm -f "$CLAUDE_PROJECT_DIR/memory/.reconciling"' EXIT
```

For each chosen cron, build an **adapted prompt**:

1. Prepend: `"You are running as agent <AgentName>. Read SOUL.md, IDENTITY.md, USER.md for context. "`
2. Apply token replacements:
   - `sessions_spawn(...)` → `"Use the Agent tool (one-shot delegation)"`
   - `sessions_send(...)` → `"Use the Agent tool"`
   - `message(...)` → `"Use the messaging plugin's reply tool (or append to memory/$(date +%Y-%m-%d).md if no plugin is loaded)"`
3. If `delivery.channel` is set, append: `"Send the result via <channel> reply tool; if the plugin isn't loaded, append to memory/$(date +%Y-%m-%d).md instead."`
4. Convert schedule:
   - `kind: cron` → keep `expr`, drop `tz` (CronCreate uses local time)
   - `kind: every` with `everyMs` → `*/N * * * *` where N is `max(1, round(everyMs / 60000))`. If N > 59, warn and fall back to `0 */N * * *` if possible, otherwise skip with a red warning.
   - `kind: at` → one-shot with `recurring: false`. If `expr` is a specific date, convert to a minute-precision cron that fires once around that time; if `expr` is null, skip.

Then load the CronCreate schema (first time per session), create the cron, and immediately register it in the registry with the stable OpenClaw key:

```bash
ToolSearch(query="select:CronCreate")   # deferred tool, load schema once
```
```
CronCreate(
  cron: "<converted expr>",              # parameter is `cron`, NOT `schedule`
  prompt: "<adapted message>",
  durable: true,
  recurring: <true for cron/every, false for at>
)
# Capture the returned 8-hex task_id from the response.
```
```bash
bash "$CLAUDE_PLUGIN_ROOT/skills/crons/writeback.sh" upsert \
  --key "openclaw-<original-uuid>" \
  --source openclaw-import \
  --harness-task-id "<new task_id>" \
  --cron "<converted expr>" \
  --prompt "<adapted message>" \
  --recurring <true|false>
```

The `--source openclaw-import` also auto-marks `migration.openclawAnsweredAt = "auto-imported"` if it was null, preventing future SessionStart migration offers.

For RED crons the user forced via `s`, include a warning in the prompt: `"[WARNING: this cron depends on <specific reason> which has no Claude Code equivalent — it may fail at runtime]"`.

After the batch, remove the suppression marker:
```bash
rm -f "$CLAUDE_PROJECT_DIR/memory/.reconciling"
trap - EXIT
```

**D.6 — Per-item summary**:
```
Crons imported (<G+Y>):
  ✅ Ideas Check-in (0 14 * * 3,6)
  ✅ reddit-ideas-scan (0 3 * * *)
  ⚠️  meditation (0 2 * * *) — whatsapp channel fallback to memory file
  ⚠️  wacli-keepalive (every 4h → 0 */4 * * *)
  ...

Skipped (<R>):
  ❌ eva-sync-systemEvent — kind:systemEvent has no Claude Code equivalent
  ❌ old-reminder-at — kind:at with expired timestamp
  ❌ cc-task-monitor — payload references `http://192.168.3.102:3123` Control Center HTTP
  ...
```

**D.7 — Record skipped crons in the backlog.** Append entries to `./IMPORT_BACKLOG.md` under `## Crons — Skipped`. Format:

```markdown
### eva-sync-systemEvent (ID: `1234-abcd-...`)
- **Original schedule**: `kind: systemEvent` (every 5min)
- **Original agentId**: `main`
- **Reason**: `kind: systemEvent` is an OpenClaw internal tick — no Claude Code equivalent
- **Original payload** (first 200 chars): `<truncated message>`
- **Recovery notes**: SystemEvent crons triggered internal ticks. To port, convert to an `agentTurn` with an equivalent prompt and register via `/agent:crons`.
```

### Step E — Backlog + memory + reminder

After Steps C and D, consolidate the backlog and register the import event in the agent's memory so the agent can retrieve the context later.

**E.1 — Finalize `./IMPORT_BACKLOG.md`.** If the file was created during C.8 or D.7, make sure it has the header at the top:

```markdown
# Import Backlog — Items Not Imported Automatically

This file records OpenClaw skills and crons from the import flow that couldn't be translated directly to Claude Code. Review each entry and decide case-by-case: port manually, set up the missing infrastructure, or drop the item.

Generated: <YYYY-MM-DD HH:MM>
Source workspace: <path>
Agent: <Name>

---

## Skills — Skipped
<entries from C.8>

## Crons — Skipped
<entries from D.7>
```

If both lists are empty, don't create the file — print `"Backlog: empty (everything was importable)"` to the user.

**E.2 — Record the import event in memory.** Append to `memory/$(date +%Y-%m-%d).md`:

```markdown
## Import event ($(date +%H:%M))

Imported agent <Name> from `<path>`.

- Skills imported: <G+Y> (<G> portable, <Y> need adaptation — details in IMPORT_BACKLOG.md)
- Skills skipped: <R> — see `IMPORT_BACKLOG.md` for the full list and recovery notes
- Crons imported: <G+Y> (<G> as-is, <Y> adapted)
- Crons skipped: <R> — see `IMPORT_BACKLOG.md`

**If the user asks** *"what about X cron/skill?"*, *"let's revisit the ones we skipped"*, or *"how do we recover Y?"*, read `IMPORT_BACKLOG.md` for the specific reason and recovery notes, then help them port it.

**Skipped skills were**: fix-api-keys, control-center, reminders, ... (list names)
**Skipped crons were**: eva-sync-systemEvent, cc-task-monitor, ... (list names)
```

This is important: the memory entry is how the agent "remembers" the backlog exists across sessions. Without it, when the user later says "retomemos los crons" the agent won't know which crons were skipped.

**E.3 — Offer a reminder cron (optional).** Ask the user with `AskUserQuestion`:

```
question: "¿Configuro un recordatorio semanal para que revises los items que no se importaron automáticamente (IMPORT_BACKLOG.md)?",
header: "Recordatorio semanal",
options:
  - label: "Sí, lunes 10:00"
  - label: "No, gracias"
```

If yes, suppress PostToolUse, create + register explicitly:

```bash
touch "$CLAUDE_PROJECT_DIR/memory/.reconciling"
```
```
CronCreate(
  cron: "0 10 * * 1",
  prompt: "Read ./IMPORT_BACKLOG.md and remind the user about any skipped skills/crons that still need porting. If the file is empty or doesn't exist, do nothing.",
  durable: true,
  recurring: true
)
# Capture returned 8-hex task_id.
```
```bash
bash "$CLAUDE_PLUGIN_ROOT/skills/crons/writeback.sh" upsert \
  --key "backlog-reminder" \
  --source backlog-reminder \
  --harness-task-id "<new task_id>" \
  --cron "0 10 * * 1" \
  --prompt "Read ./IMPORT_BACKLOG.md and remind the user about any skipped skills/crons that still need porting. If the file is empty or doesn't exist, do nothing." \
  --recurring true \
  --note "Weekly backlog review reminder"

rm -f "$CLAUDE_PROJECT_DIR/memory/.reconciling"
```

If no, continue without the cron — the memory entry and the file itself are enough for later retrieval.

### Step F — Messaging channel (optional)

Use `AskUserQuestion`:

```
AskUserQuestion(
  question: "Set up a messaging channel so you can reach this agent from your phone?",
  options: [
    { label: "WhatsApp (recommended)", description: "Via crisandrews/claude-whatsapp. QR scan pairing." },
    { label: "Telegram", description: "Official Bot API via claude-plugins-official." },
    { label: "Other", description: "Discord, iMessage, Slack — I'll guide you." },
    { label: "Later", description: "Skip for now. Run /agent:messaging anytime." }
  ]
)
```

**Wait for the answer.** If the user picks a platform, run the `/agent:messaging` skill flow for that platform. If "Later", skip.

If the user already has a messaging plugin installed (from a previous agent), offer to add its log directory to `memory.extraPaths` so past conversations become searchable.

### Step G — Reload

Tell the user to reload the MCP server so all the new config takes effect:
```
/mcp
```

Select `clawcode` and reconnect.

## Part 3: Report

Summarize what was imported and what was set up:

```
✅ Import complete

Agent: <Name> <emoji>
Files copied: <N> bootstrap + <M> memory files
Memory backend: <builtin | qmd>
Skills:   <G> as-is, <Y> adapted, <R> skipped (or "skipped" if user chose [n])
Crons:    <G> as-is, <Y> adapted, <R> skipped + 2 default (heartbeat, dreaming)
Backlog:  IMPORT_BACKLOG.md written (<Sr + Cr> items pending review)  [or: "empty"]
Memory:   Import event logged to memory/<YYYY-MM-DD>.md
Messaging: <not yet | <platform> | skipped>

Per-item details scrolled above. For any ⚠️ or ❌, read the reason and decide
if you want to port it manually. Later, ask me "let's revisit the backlog" and
I'll read IMPORT_BACKLOG.md to help you work through the pending items.

Next: /mcp to reload and start using the agent.
```

## Backlog file template

When Step C.8 or D.7 first writes to `./IMPORT_BACKLOG.md`, create the file with this skeleton:

```markdown
# Import Backlog — Items Not Imported Automatically

This file records skills and crons from the import that couldn't be
translated directly. Review each entry and decide case-by-case:
port manually, set up the missing infrastructure, or drop the
item.

Generated: <YYYY-MM-DD HH:MM>
Source workspace: <path>
Agent: <Name>

---

## Skills — Skipped

<entries from Step C.8 appended here, one H3 per skill>

## Crons — Skipped

<entries from Step D.7 appended here, one H3 per cron>
```

## Important

- **Never copy credential files** (API keys, passwords, tokens, `.env`).
- **Always ask** before overwriting existing files in the current directory.
- **AGENTS.md adaptation is critical** — remove OpenClaw tool references, keep behavioral rules.
- **Part 2 (post-import setup) is what makes imports reach full parity** with freshly-created agents. Don't skip it — an imported agent without crons, skills, and memory config is a shell of the original.
- **Steps C and D are interactive** — always present the menu and respect the user's choice. Don't silently import all skills/crons without asking, and don't silently skip them either.
- **Per-item "why" messages are mandatory for skipped items** — saying "14 skills were RED" is not useful. Saying "fix-api-keys skipped because it depends on `gateway config.patch` (OpenClaw gateway, no Claude Code equivalent)" is useful.
- **The backlog is not optional** — every skipped item must end up in `IMPORT_BACKLOG.md` AND in the memory entry at `memory/<date>.md`. That's how the user can later ask "retomemos los crons que no se importaron" and the agent can find the context.
- If the user is in a hurry, they can skip steps C, D, F and run `/agent:crons`, `/agent:messaging` later — but Step E (backlog + memory) should still run if Steps C or D ran at all.
