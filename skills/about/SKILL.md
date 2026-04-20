---
name: about
description: Show the plugin source — name, version, and repo URL. Works from CLI or messaging. Triggers on /about, /version, /agent:about, /agent:version, "qué versión", "what version", "about the plugin", "about clawcode".
user-invocable: true
---

# /about — Plugin source & version

Show a small card with the plugin name, version, and repo URL. Answers "where does this agent come from?" / "what version am I running?".

## Output format

```
🔌 ClawCode v<version>
Repo: https://github.com/crisandrews/ClawCode
Issues / stars: same link · feedback welcome
```

## Steps

1. **Get the version** — preferred: call the `watchdog_ping` MCP tool; it returns `{ok, version, ts, plugins}` and is the cheapest way to get the live value (no filesystem reads).

   Fallback if the tool isn't available: Bash:
   ```bash
   jq -r .version "$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json"
   ```

   Never hardcode the version — always read it at runtime.

2. **Detect the surface** for bold formatting:
   - CLI / Telegram / WebChat: `**bold**`
   - WhatsApp: `*bold*` (single asterisk, no markdown headers)
   - Discord: `**bold**` as-is
   - iMessage: plain text, strip bold

3. **Print the card** using REAL data. One card, no preamble, no persona-intro.

## Format per surface

**Tail-line language:** the "Issues / stars …" line adapts to the user's conversation language. **Default to EN** if there's no clear signal. Known translations:

- `en` → `Issues / stars: same link · feedback welcome`
- `es` → `Issues / stars: mismo link · feedback bienvenido`
- `pt` → `Issues / stars: mesmo link · feedback bem-vindo`

For other languages, keep the structure and translate the tail naturally.

### CLI / WebChat

```
🔌 **ClawCode** v<version>
Repo: https://github.com/crisandrews/ClawCode
<tail-line-in-user-language>
```

### WhatsApp

```
🔌 *ClawCode* v<version>
Repo: https://github.com/crisandrews/ClawCode
<tail-line-in-user-language>
```

Bold uses single `*` on WhatsApp (no markdown headers).

### Telegram

Same as CLI/WebChat.

## Important

- `/about` and `/version` are aliases — same response.
- Only respond when the user asks explicitly. Never volunteer this card unprompted.
- One card. No extra commentary, no persona-intro ("Soy …"). The user asked for metadata, give them metadata.
- For "what can I do?" the user wants `/help`, not `/about` — do not conflate.
