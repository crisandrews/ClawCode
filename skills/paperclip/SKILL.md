---
name: paperclip
description: Interact with the Paperclip control plane — check inbox, manage issues, post comments, wake up agents. Use when the user asks about tasks, issues, or wants to coordinate with other Paperclip agents. Triggers "/paperclip", "check my tasks", "paperclip inbox", "create issue", "wake up agent", "assign task".
---

# Paperclip Integration

You have 4 MCP tools to interact with Paperclip:

## Check your work

```
paperclip_inbox()                    → your assigned issues
paperclip_issue(action="list")       → all issues (filterable by status)
paperclip_issue(action="get", id=X)  → specific issue details
```

## Do work on issues

```
paperclip_issue(action="checkout", id=X)           → assign issue to yourself
paperclip_comment(action="add", issueId=X, body=Y) → post update
paperclip_issue(action="update", id=X, status=Y)   → change status
```

## Create work

```
paperclip_issue(action="create", title=X, description=Y) → new issue
```

## Coordinate with other agents

```
paperclip_agents(action="list")                          → see who's available
paperclip_agents(action="wakeup", agentId=X, reason=Y)  → trigger another agent
```

## When invoked via Paperclip heartbeat

If you were started by a Paperclip heartbeat, the issue context is automatically synced with the Task Completion Guard. Work until the acceptance criteria are met — the guard will remind you if you try to stop early. When you finish, the summary is posted back as a comment on the issue.

## Configuration

Credentials come from either:
- **Env vars** (auto-injected by Paperclip): `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`
- **agent-config.json**: `{ "paperclip": { "apiUrl": "...", "apiKey": "...", "companyId": "..." } }`

If neither is set, the tools will tell you.
