---
name: crons
description: Manage scheduled reminders (crons) — list, add, delete, pause, resume, reconcile, or import from OpenClaw. Triggers on /agent:crons, /agent:reminders; listing ("list reminders", "show crons", "recordatorios", "mis crons", "mis recordatorios"); creating from natural language via any channel ("recordame", "recuérdame", "me recuerdas", "hazme acordar", "agendame", "agéndame", "avísame", "remind me", "remind me in", "reminder in", "schedule a reminder", "set a reminder", "wake me at", "every day at", "todos los días a las", "every monday|tuesday|...", "todos los lunes|martes|...", "cada N minutos|horas"); importing ("import crons", "importar crons", "traer crons").
user-invocable: true
---

# Crons & Reminders

This workspace maintains a persistent cron registry at `memory/crons.json` — the source of truth for every scheduled task across sessions. The SessionStart hook reconciles it against the live harness; the PostToolUse hook captures ad-hoc `CronCreate`/`CronDelete` calls automatically.

All writes to the registry go through one script: `bash ${CLAUDE_PLUGIN_ROOT}/skills/crons/writeback.sh <subcommand>`. Never edit `memory/crons.json` by hand.

**`CronCreate` / `CronList` / `CronDelete` are deferred tools** — call `ToolSearch(query="select:CronList,CronCreate,CronDelete")` once per session before invoking them. The parameter name is `cron`, not `schedule`. Always pass `durable: true` (forward-compat for when the upstream flag is fixed).

---

## ⛔ FORBIDDEN — read before touching anything

These rules are non-negotiable. Violating any of them silently breaks reminders for the user.

1. **Never compute cron expressions yourself.** LLMs miscompute timezones inconsistently (sometimes UTC, sometimes local — verified empirically). Claude Code's cron daemon uses the **host's LOCAL time**. The only correct way to produce a cron expression is to call `bash $CLAUDE_PLUGIN_ROOT/bin/cron-from.sh ...`. The helper does deterministic epoch arithmetic and returns cron + human-readable confirmation in the host's TZ. *(Enforced: a PreToolUse hook blocks `CronCreate` with exit 2 unless the cron expression matches a cron-from.sh output from the last 120s. If the mode you need isn't covered by `relative`/`absolute`/`recurring`, use `cron-from.sh passthrough "<cron>"` as an escape hatch.)*

2. **Never use `ScheduleWakeup` for user-facing commitments.** `ScheduleWakeup` is intra-session only (dies on `/exit`). Any reminder, alert, or recurring task the user requests via chat MUST go through `CronCreate(durable: true)`. The reconcile hook keeps it alive across restarts.

3. **Never tell the user the reminder is "session-only", "may not arrive", or any equivalent degraded-persistence phrasing in any language.** With this skill, every commitment is durable. If you genuinely cannot create the cron (e.g. helper failed), surface the error to the user — don't silently degrade to a verbal-only promise.

4. **Never call `writeback.sh upsert` after a `CronCreate` for an ad-hoc reminder.** The PostToolUse hook captures it automatically with `source: ad-hoc`. Manual upsert would duplicate. *(Enforced: `writeback.sh upsert` refuses with exit 5 if an active entry with the same cron + prompt already exists under a different key. If you see that error, the hook already did its job — drop your manual upsert call.)*

### Common failure pattern (verified 2026-04-19)

When the agent thinks "I know what time +2 minutes is, I'll just compute the cron myself" and skips the helper, this is the bug that ships:

```
Now (local):     15:21  (UTC-4, Santiago)
User asks:       "recordame en 2 minutos"
Agent computes:  15:21 + 2 = 15:23 → grabs UTC hour by mistake
                 → cron = "23 19 19 4 *"  ← hour 19 (UTC), not 15 (local)
Daemon fires at: 19:23 LOCAL (cron uses local time of host)
                 = 7:23 PM = 4 hours late
```

The helper exists exactly to prevent this. There is no situation in which computing a cron expression in your head is acceptable — even for "obvious" cases like "in 2 minutes". Always run `bash $CLAUDE_PLUGIN_ROOT/bin/cron-from.sh ...` first.

---

## Subcommand dispatcher

Parse the user's phrasing and route to the right flow:

| Phrasing | Subcommand |
|---|---|
| `/agent:crons list`, `/agent:reminders`, "list reminders", "show crons", "recordatorios", "mis crons", or no args (registry populated) | **LIST** |
| `/agent:crons add <cron> <prompt>`, "add reminder", "agrega un recordatorio", **plus all natural-language requests for a future-time commitment**: "recordame en X", "me recuerdas en X", "hazme acordar X", "avísame a las X", "agendame X", "remind me in X", "remind me at X", "every Monday at X", "todos los lunes a X", "cada N minutos/horas", etc. | **ADD** |
| `/agent:crons delete <key|N>`, "delete reminder X", "borra el recordatorio X" | **DELETE** |
| `/agent:crons pause <key>`, "pausa reminder X" | **PAUSE** |
| `/agent:crons resume <key>`, "reanuda X" | **RESUME** |
| `/agent:crons reconcile`, "reconcile" | **RECONCILE** |
| `/agent:crons import`, "importar crons", "traer crons", or no args (OpenClaw source present + registry empty) | **IMPORT** |

---

## LIST — show current reminders

1. Call `CronList`. Output is plain text, one line per live job:
   ```
   <8hex-id> — <cron-expr> (recurring|one-shot) [session-only|durable]: <prompt>
   ```
   Empty state is the literal string `No scheduled jobs.`.

2. Read the registry:
   ```bash
   cat "$CLAUDE_PROJECT_DIR/memory/crons.json" | jq -c '.entries[]'
   ```

3. For each registry entry (skip `tombstone != null` unless the user asks for audit):
   - **✅ alive** — `harnessTaskId` appears in CronList.
   - **⚠️ missing** — expected (paused:false, tombstone:null) but not alive.
   - **⏸ paused** — `paused: true`.
   - **🪦 tombstoned** — `tombstone != null` (only show if user asked).

4. Render a compact table. Example:
   ```
   #  STATUS  KEY                         CRON              PROMPT
   1  ✅      heartbeat-default           */30 * * * *      Run /agent:heartbeat
   2  ✅      dreaming-default            0 3 * * *         Use the dream tool...
   3  ⏸       harness-abc12345            0 9 * * *         recordame estirarme
   ```

---

## ADD — create a new reminder

Re-read the ⛔ FORBIDDEN block above before every ADD. The "Common failure pattern" section is the exact bug you will ship if you skip it.

**Before saying anything to the user, before calling any tool other than the helper**, identify the natural-language time phrase in the user's message and run `bash $CLAUDE_PLUGIN_ROOT/bin/cron-from.sh ...` (Step 1+2). Only then proceed to CronCreate (Step 3) and the user reply (Step 4). Do not narrate "I will now run the helper" — just run it.

### Step 1 — Parse user intent into structured helper args

Map the user's phrasing to one of the helper's three modes:

| User says | Helper invocation |
|---|---|
| "recordame en 3 minutos X", "remind me in 5 min" | `cron-from.sh relative 3 minutes` |
| "en 2 horas", "in 1 hour" | `cron-from.sh relative 2 hours` |
| "en 3 días" | `cron-from.sh relative 3 days` |
| "a las 14:30", "at 2:30pm" | `cron-from.sh absolute "14:30"` (auto-rolls to tomorrow if past) |
| "mañana a las 9", "tomorrow at 09:00" | `cron-from.sh absolute "09:00" tomorrow` |
| "todos los días a las 8", "every day at 8am" | `cron-from.sh recurring daily "08:00"` |
| "todos los lunes a las 9", "every Monday at 9am" | `cron-from.sh recurring weekly mon "09:00"` |
| "cada 30 minutos", "every 30 minutes" | `cron-from.sh recurring every 30 minutes` |
| "cada 2 horas" | `cron-from.sh recurring every 2 hours` |

If the user's request is ambiguous (e.g. "recordame mañana" without a time, or "every week" without a day), use `AskUserQuestion` to pin it down **before** calling the helper:
```
question: "¿A qué hora?",
options: [ "09:00", "14:00", "18:00", "otra" ]
```

### Step 2 — Call the helper

```bash
bash "$CLAUDE_PLUGIN_ROOT/bin/cron-from.sh" <args>
```

Example for "recordame en 3 minutos":
```bash
bash "$CLAUDE_PLUGIN_ROOT/bin/cron-from.sh" relative 3 minutes
```

Output (single-line JSON — parse with `jq`):
```json
{"cron":"25 13 19 4 *","human_local":"13:25 (Sun 19 Apr)","iso_local":"2026-04-19T13:25:00-0400","epoch":1776619500,"recurring":false,"kind":"relative"}
```

Use `.cron` verbatim for `CronCreate`. Use `.human_local` for the user confirmation. If the helper exits non-zero, show its stderr to the user — do NOT fall back to self-computed crons.

### Step 3 — Create the cron

```
ToolSearch(query="select:CronCreate")   # once per session
CronCreate(
  cron: "<output.cron>",
  prompt: "<action to fire; see reminder prompt template below>",
  durable: true,
  recurring: <output.recurring as boolean>
)
```

The PostToolUse hook captures the new cron into `memory/crons.json` with `source: ad-hoc` and key `harness-<task_id>`. **Do NOT call `writeback.sh upsert` afterward** — the hook handles it.

#### Reminder prompt template (for messaging channels)

When the cron fires, the agent is given the `prompt` text as a new turn. Write it so the agent knows exactly what to do. Keep the structural words (Reminder for, Reply via, Message style) in English so the firing agent parses reliably; write the user-facing message in the user's conversation language `<lang>`.

```
Reminder for <user>: <thing-to-remember>. Reply via the <channel> reply tool
to chat <chat-id>. Message style (<lang>): "<short-natural-message-in-user-lang>".
```

Example for an `es` user on WhatsApp:
```
Reminder for JC: buy vitamins. Reply via the WhatsApp reply tool to
chat 199999598137448@lid. Message style (es): "JC, acuérdate de comprar vitaminas 💊".
```

### Step 4 — Confirm to the user

Reply in the user's conversation language (`<lang>`). Use `human_local` from the helper output for the time, never invent it. Examples (substitute `<lang>` accordingly):

- en: `Done. I'll remind you at <human_local> to <thing>.`
- es: `Listo. Te aviso a las <human_local> para <thing>.`
- pt: `Pronto. Te aviso às <human_local> para <thing>.`

Never say "session-only", "may not arrive", "vive en esta sesión", "puede que no llegue", or any equivalent degraded-persistence wording in any language. The registry + reconcile guarantees the cron survives session restarts.

---

## DELETE — remove a reminder

1. Resolve the user's target to a registry key. Accept either:
   - Registry key directly (e.g. `harness-abc12345`)
   - 1-based index from the last `list` output

2. Read registry to find the entry's `harnessTaskId` and display the cron + prompt.

3. Use `AskUserQuestion` to confirm:
   ```
   question: "¿Borrar el recordatorio '<prompt>' (<cron>)?",
   header: "Confirmación",
   options:
     - label: "Sí, borrar"
     - label: "Cancelar"
   ```

4. If confirmed:
   - Call `CronDelete(id=<harnessTaskId>)`. PostToolUse auto-tombstones on success.
   - If the entry has no `harnessTaskId` (already dead / paused), manually tombstone it via:
     ```bash
     bash "$CLAUDE_PLUGIN_ROOT/skills/crons/writeback.sh" tombstone --key <key>
     ```

---

## PAUSE — temporarily stop without deleting

Pause keeps the registry entry but removes the cron from the harness. Useful for "silence this reminder but don't lose it".

1. Touch the suppression marker so PostToolUse won't tombstone on the upcoming `CronDelete`:
   ```bash
   touch "$CLAUDE_PROJECT_DIR/memory/.reconciling"
   ```

2. Read the entry's current `harnessTaskId`. If non-null, call `CronDelete(id=<id>)`.

3. Mark paused in the registry:
   ```bash
   bash "$CLAUDE_PLUGIN_ROOT/skills/crons/writeback.sh" pause --key <key>
   ```

4. Remove the marker:
   ```bash
   rm -f "$CLAUDE_PROJECT_DIR/memory/.reconciling"
   ```

5. Confirm: `⏸ <key> pausado. Usa "/agent:crons resume <key>" para reactivar.`

---

## RESUME — re-enable a paused reminder

1. Touch the suppression marker:
   ```bash
   touch "$CLAUDE_PROJECT_DIR/memory/.reconciling"
   ```

2. Read the entry's `cron`, `prompt`, `recurring` from the registry.

3. Call `CronCreate(cron, prompt, durable=true, recurring)`. Capture the new 8hex `task_id` from the response.

4. Record the new link:
   ```bash
   bash "$CLAUDE_PLUGIN_ROOT/skills/crons/writeback.sh" resume --key <key> --harness-task-id <new_task_id>
   ```

5. Remove the marker:
   ```bash
   rm -f "$CLAUDE_PROJECT_DIR/memory/.reconciling"
   ```

6. Confirm: `▶️ <key> reactivado.`

---

## RECONCILE — force a sync

Run the same logic as SessionStart reconcile, on demand:

1. Call `CronList`.
2. For each registry entry (paused:false, tombstone:null) whose `harnessTaskId` is not in CronList output: `CronCreate` + `writeback.sh set-alive`.
3. Pipe CronList output to `writeback.sh adopt-unknown` to capture any live-but-unknown crons.
4. Print summary.

---

## IMPORT — bring OpenClaw crons into the registry

Used when the user has an existing `~/.openclaw/cron/jobs.json` from a previous OpenClaw agent and wants to port those reminders into this workspace.

### Setup: suppress PostToolUse capture during the batch

Imports need custom registry keys (`openclaw-<uuid>`) and `source: openclaw-import`. Since PostToolUse would otherwise capture each `CronCreate` as `source: ad-hoc` with `harness-<id>` key, suppress it for the duration:

```bash
touch "$CLAUDE_PROJECT_DIR/memory/.reconciling"
```

Remove the marker at the end of the batch (or via trap on error).

### 1. Read source

```bash
cat ~/.openclaw/cron/jobs.json
```

The file shape is `{"version": 1, "jobs": [...]}`. Each job:
```json
{
  "id": "uuid",
  "agentId": "main",
  "name": "Job Name",
  "enabled": true,
  "schedule": { "kind": "cron", "expr": "0 14 * * 3,6", "tz": "America/Santiago" },
  "payload": { "kind": "agentTurn", "message": "prompt here", "model": "opus" },
  "delivery": { "mode": "announce", "channel": "whatsapp" }
}
```

Iterate `data["jobs"]`, not `data`.

### 2. Filter by agent

Use the active agent's ID (check `IDENTITY.md` or `agent-config.json`). If ambiguous, ask the user with `AskUserQuestion`.

### 3. Classify (3 tiers)

```bash
HARD_RED='sessions_spawn|gateway config\.patch|http://192\.168\.|canvas\(|remindctl|wacli|openclaw gateway|HEARTBEAT_OK|NO_REPLY|peekaboo'
SOFT_YELLOW='sessions_send|message\(|~/\.openclaw/|\.openclaw/credentials'
```

| Tier | Criteria | Action |
|---|---|---|
| 🟢 GREEN | `enabled: true`, `kind: cron`, `payload.kind: agentTurn`, no HARD_RED match, delivery.channel plugin installed (if any) | Import as-is |
| 🟡 YELLOW | `kind: at` with future timestamp, `kind: every` (convertible), uninstalled channel, or SOFT_YELLOW match | Import with adapted prompt + fallback note |
| 🔴 RED | `enabled: false`, expired `at`, `kind: systemEvent`, or HARD_RED match | Skip. Record reason. |

Record the specific reason per item (which token matched which field).

### 4. Present interactive menu via `AskUserQuestion`

```
question: "<agent> tiene <N> crons importables. ¿Qué hacés?",
header: "Importar crons",
options:
  - label: "Importar todos (G+Y)"
  - label: "Elegir uno por uno"
  - label: "Listar con status primero"
  - label: "Saltar"
```

### 5. Field mapping per cron

| OpenClaw field | CronCreate parameter | Notes |
|---|---|---|
| `schedule.expr` | `cron` (5-field) | Direct. Drop `tz` (Claude Code uses local time). |
| `schedule.kind: "at"` | `cron` + `recurring: false` | Convert ISO timestamp to minute-precision cron for that date. |
| `schedule.kind: "every"` | `cron` = `*/N * * * *` | `N = max(1, round(everyMs / 60000))` |
| `payload.message` | `prompt` | Apply token adaptation (below). |
| `name` | (not a parameter) | Include as a prefix comment inside the prompt for identification. |
| `delivery.channel: "whatsapp"` | Appended to prompt | "Send the result via WhatsApp reply tool; fallback to memory file if plugin not loaded." |

### 6. Token adaptation

Prepend: `You are running as agent <Name>. Read SOUL.md, IDENTITY.md, USER.md for context.`

Replace inside the message:
- `sessions_spawn(...)` → `Use the Agent tool (one-shot delegation)`
- `sessions_send(...)` → `Use the Agent tool`
- `message(...)` → `Use the messaging plugin's reply tool (or append to memory/$(date +%Y-%m-%d).md if no plugin is loaded)`
- Keep `memory_search` / `memory_get` (ClawCode exposes them).

### 7. For each selected cron — create + register

```bash
ToolSearch(query="select:CronCreate")   # once per session
CronCreate(
  cron: "<expr>",
  prompt: "<adapted message>",
  durable: true,
  recurring: <true for cron/every, false for at>
)
# Capture the returned 8-hex task_id.

bash "$CLAUDE_PLUGIN_ROOT/skills/crons/writeback.sh" upsert \
  --key "openclaw-<original-uuid>" \
  --source openclaw-import \
  --harness-task-id "<new task_id>" \
  --cron "<expr>" \
  --prompt "<adapted message>" \
  --recurring <true|false>
```

The explicit `--key openclaw-<uuid>` + `--source openclaw-import` overrides what PostToolUse would have captured (which we're suppressing via `.reconciling` marker anyway).

Running upsert with `--source openclaw-import` also auto-marks `migration.openclawAnsweredAt = "auto-imported"` in the registry — prevents the SessionStart migration offer from re-appearing next session.

### 8. Report per-item result

```
Crons imported (<G+Y>):
  ✅ Ideas Check-in (0 14 * * 3,6)
  ⚠️  meditation (0 2 * * *) — whatsapp channel → fallback to memory file

Skipped (<R>):
  ❌ eva-sync-systemEvent — kind:systemEvent has no Claude Code equivalent
  ❌ cc-task-monitor — references http://192.168.3.102:3123 (HARD_RED)
```

### 9. Cleanup

```bash
rm -f "$CLAUDE_PROJECT_DIR/memory/.reconciling"
```

If imports failed mid-batch, remove the marker anyway (don't leak it — posttool would skip captures for up to 10 minutes until the stale check kicks in).

---

## Important notes

- **Persistence is now guaranteed across sessions** via `memory/crons.json` + reconcile. The old `.crons-created` marker is obsolete and cleaned up on first reconcile.
- Recurring crons still auto-expire in the harness after 7 days — reconcile recreates them every session.
- Crons fire only while the Claude Code REPL is idle. For 24/7, use `/agent:service install`.
- All interactive surfaces in this skill use native `AskUserQuestion` (REPL-only, one question at a time).
