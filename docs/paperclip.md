# Paperclip Integration

Native bridge between ClawCode and the [Paperclip](https://github.com/anthropics/paperclip) agent control plane. Enables bidirectional communication: ClawCode agents can manage Paperclip issues, and Paperclip heartbeats can drive ClawCode's Task Completion Guard.

## Setup

### Option A: Environment variables (automatic via Paperclip heartbeat)

When Paperclip invokes a ClawCode agent via heartbeat, it injects:

```
PAPERCLIP_API_URL=http://localhost:3000
PAPERCLIP_API_KEY=pk_agent_...
PAPERCLIP_COMPANY_ID=<uuid>
PAPERCLIP_AGENT_ID=<uuid>
PAPERCLIP_RUN_ID=<uuid>
```

No configuration needed — the bridge auto-detects these.

### Option B: agent-config.json (manual setup)

```json
{
  "paperclip": {
    "apiUrl": "http://localhost:3000",
    "apiKey": "pk_agent_...",
    "companyId": "<uuid>",
    "autoSync": true
  }
}
```

## MCP Tools

### `paperclip_inbox`
Get your assigned issues and pending tasks.

### `paperclip_issue`
| Action | Required | Description |
|---|---|---|
| `get` | `id` | Fetch issue by ID or identifier |
| `list` | — | List issues (optional: `status`, `limit`) |
| `create` | `title` | Create new issue (optional: `description`) |
| `update` | `id` | Update issue (optional: `status`, `title`, `description`) |
| `checkout` | `id` | Assign issue to agent (optional: `agentId`) |

### `paperclip_comment`
| Action | Required | Description |
|---|---|---|
| `list` | `issueId` | List comments (optional: `limit`) |
| `add` | `issueId`, `body` | Post a comment |

### `paperclip_agents`
| Action | Required | Description |
|---|---|---|
| `list` | — | List all agents in the company |
| `wakeup` | `agentId` | Invoke heartbeat on an agent (optional: `reason`) |

## Task Ledger Sync

When `autoSync` is enabled (default) and ClawCode is invoked via a Paperclip heartbeat:

1. The bridge reads the heartbeat context (issue title, description)
2. Extracts acceptance criteria from markdown checklists in the description
3. Opens a `task_ledger` entry with those criteria
4. The **Task Completion Guard** enforces completion — the agent can't stop until criteria are met
5. On `task_close`, a summary comment is posted back to the Paperclip issue

This means: assign an issue to a ClawCode agent in Paperclip, and the agent will work until it's done (or explain why it can't finish).

## Architecture

```
 Paperclip Control Plane
     │
     │ heartbeat (spawns agent process)
     │ env: API_URL, API_KEY, COMPANY_ID, RUN_ID
     ▼
 ClawCode MCP Server
     │
     ├── paperclip-bridge.ts  → HTTP client (REST API)
     ├── paperclip-sync.ts    → Heartbeat → Task Ledger sync
     ├── task-ledger.ts       → Acceptance criteria enforcement
     └── task-guard-cli.ts    → Stop hook blocks until done
                                    │
                                    │ task_close → POST comment
                                    ▼
                              Paperclip Issue (updated)
```

## Files

| File | Description |
|---|---|
| `lib/paperclip-bridge.ts` | HTTP client wrapping Paperclip REST API |
| `lib/paperclip-sync.ts` | Heartbeat ↔ Task Ledger synchronization |
| `lib/config.ts` | `paperclip` config block in AgentConfig |
| `server.ts` | 4 MCP tools (inbox, issue, comment, agents) |
| `skills/paperclip/SKILL.md` | User-invocable skill |
| `docs/paperclip.md` | This file |
