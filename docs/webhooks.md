# Webhooks — External Systems Talking to Your Agent

The HTTP bridge exposes `POST /v1/webhook` so any external system can send events to the agent. Events are queued and the agent processes them on its next idle turn.

## How it works

```
External system  →  POST /v1/webhook  →  Queue (up to 1000)  →  Agent reads via MCP
```

1. External system sends a JSON POST to `http://localhost:18790/v1/webhook`
2. The bridge queues it with a timestamp, ID, and source headers
3. The agent reads queued events via `chat_inbox_read` MCP tool (or `GET /v1/webhooks`)
4. The agent processes the event — responds, logs to memory, takes action

## Sending a webhook

```sh
curl -X POST http://localhost:18790/v1/webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Source: github" \
  -d '{"event": "push", "repo": "my-app", "branch": "main", "commits": 3}'
```

If auth is configured, add the token:

```sh
curl -X POST http://localhost:18790/v1/webhook \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"event": "alert", "service": "api", "status": "down"}'
```

## Response

```json
{
  "accepted": true,
  "id": "wh_1776025820614_wzid9g",
  "queueSize": 1
}
```

Status `202 Accepted` means the event is queued. The agent will process it when idle.

## Use cases

### CI/CD (GitHub Actions)

```yaml
# .github/workflows/notify-agent.yml
- name: Notify agent
  run: |
    curl -X POST http://your-host:18790/v1/webhook \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${{ secrets.AGENT_TOKEN }}" \
      -d '{"event": "deploy", "status": "${{ job.status }}", "repo": "${{ github.repository }}"}'
```

The agent receives the event and can: summarize, notify via WhatsApp, log to memory, or take corrective action.

### Cloudflare Worker — scheduled tasks

```js
// wrangler.toml: [triggers] crons = ["0 9 * * *"]
export default {
  async scheduled(event, env) {
    await fetch(env.AGENT_URL + "/v1/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.AGENT_TOKEN,
      },
      body: JSON.stringify({ event: "cron", task: "daily-report" }),
    });
  }
};
```

### Cloudflare Email Worker — real-time email catch-all

Receive every email sent to your domain and forward it to the agent. Setup: [Cloudflare Email Workers docs](https://developers.cloudflare.com/email-routing/email-workers/).

```js
// email-worker.js — deploy via wrangler
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

export default {
  async email(message, env) {
    // Extract email content
    const rawEmail = await new Response(message.raw).text();
    const subject = message.headers.get("subject") || "(no subject)";
    
    // Forward to your agent's webhook
    const res = await fetch(env.AGENT_URL + "/v1/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.AGENT_TOKEN,
      },
      body: JSON.stringify({
        event: "email",
        from: message.from,
        to: message.to,
        subject,
        body: rawEmail.slice(0, 32000), // trim large emails
        headers: {
          "message-id": message.headers.get("message-id"),
          "date": message.headers.get("date"),
        }
      }),
    });
    
    if (!res.ok) {
      // Forward to fallback address if agent is down
      await message.forward("fallback@yourdomain.com");
    }
  }
};
```

**Cloudflare setup:**
1. Enable Email Routing on your domain in Cloudflare dashboard
2. Create the worker: `wrangler deploy email-worker.js`
3. In Email Routing → Routes → add a catch-all route pointing to this worker
4. Set `AGENT_URL` and `AGENT_TOKEN` as worker secrets: `wrangler secret put AGENT_TOKEN`

Now every email to `*@yourdomain.com` arrives as a webhook event. The agent can read, summarize, respond, or notify you via WhatsApp.

Full guide: [Cloudflare Email Workers](https://developers.cloudflare.com/email-routing/email-workers/) · [Community: forward emails to webhook](https://community.cloudflare.com/t/forward-all-emails-to-a-webhook/585444)

### Gmail — real-time push notifications

Gmail uses Pub/Sub to push notifications when new emails arrive. Setup: [Gmail Push Notifications](https://developers.google.com/workspace/gmail/api/guides/push).

**Architecture:** Gmail → Pub/Sub topic → Cloud Function → POST to your agent webhook

**Step 1 — Create a Pub/Sub topic:**
```sh
gcloud pubsub topics create gmail-agent
gcloud pubsub topics add-iam-policy-binding gmail-agent \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

**Step 2 — Cloud Function to forward to your agent:**
```js
// index.js — deploy as Cloud Function triggered by Pub/Sub
const fetch = require("node-fetch");

exports.gmailWebhook = async (event) => {
  const data = JSON.parse(Buffer.from(event.data, "base64").toString());
  // data = { emailAddress: "you@gmail.com", historyId: "12345" }
  
  await fetch(process.env.AGENT_URL + "/v1/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + process.env.AGENT_TOKEN,
    },
    body: JSON.stringify({
      event: "gmail-notification",
      email: data.emailAddress,
      historyId: data.historyId,
    }),
  });
};
```

**Step 3 — Subscribe Gmail to the topic:**
```sh
# Using Gmail API (via OAuth)
curl -X POST "https://gmail.googleapis.com/gmail/v1/users/me/watch" \
  -H "Authorization: Bearer $GMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"topicName": "projects/YOUR_PROJECT/topics/gmail-agent", "labelIds": ["INBOX"]}'
```

**Note:** Gmail watch expires after 7 days — re-call `watch()` daily via a cron. The notification only contains the `historyId`, not the email itself. The agent needs Gmail API access to fetch the actual email content.

Full guide: [Gmail Push Notifications](https://developers.google.com/workspace/gmail/api/guides/push) · [Step-by-step tutorial](https://livefiredev.com/step-by-step-gmail-api-webhook-to-monitor-emails-node-js/)

### Monitoring / Uptime

```sh
curl -X POST http://localhost:18790/v1/webhook \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"event": "alert", "service": "api-gateway", "status": "timeout", "duration_ms": 30000}'
```

### IoT / Sensors

```sh
curl -X POST http://localhost:18790/v1/webhook \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"event": "sensor", "device": "greenhouse", "temperature": 38.5, "humidity": 72}'
```

## Queue limits

- Max 1000 events in the queue. Oldest dropped when full.
- Max 64KB per event body.
- Events are lost if Claude Code restarts (in-memory queue).

## Draining the queue

The agent reads events via MCP tool:

```
chat_inbox_read(limit=10)
```

Or via HTTP:

```sh
curl http://localhost:18790/v1/webhooks?limit=10
```

Draining removes events from the queue. Unread events stay until drained or Claude Code restarts.

## Prerequisites

- HTTP bridge enabled: `agent_config(action='set', key='http.enabled', value='true')`
- If sending from outside localhost, configure `http.host: "0.0.0.0"` and set a token for security.
