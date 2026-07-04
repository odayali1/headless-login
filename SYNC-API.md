# Account Sync API (v1)

Efficient sync for external apps integrating with Headless Login — designed for **1k+ accounts** without polling the full token list on every batch.

**Base URL:** same as main API (`/api/v1`)  
**Auth:** required on all routes (`Authorization: Bearer API_KEY`)

See also: [API.md](./API.md) for health, single-account, and refresh endpoints.

---

## Why use sync endpoints?

| Old pattern | Sync pattern |
|-------------|--------------|
| `GET /api/v1/tokens` every N minutes | `GET /api/v1/sync/delta?since=...` — only changed accounts |
| One HTTP call per email | `POST /api/v1/sync/bulk` — up to 100 emails per call |
| Poll to detect refresh | Webhook `account.token_updated` — push on token change |

---

## 1. Bulk sync (batch lookup)

Fetch token + status for a known list of emails in **one request**.

```http
POST /api/v1/sync/bulk
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY
```

### Body

```json
{
  "emails": [
    "user1@outlook.com",
    "user2@hotmail.com"
  ],
  "target": "outlook",
  "include_refresh_token": false
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `emails` | yes | Array of emails (max **100** per request) |
| `target` | no | Default `outlook` |
| `include_refresh_token` | no | Default `false`. Set `true` only if your app needs the OAuth refresh token |

### Response

```json
{
  "ok": true,
  "max_batch": 100,
  "requested": 2,
  "found": 2,
  "not_found": [],
  "accounts": [
    {
      "email": "user1@outlook.com",
      "target": "outlook",
      "group": "client-a",
      "health": "available",
      "health_label": "Available",
      "status": "logged_in",
      "session_valid": true,
      "has_token": true,
      "access_token": "EwA...",
      "token_expires_at": "2026-07-04T12:00:00.000Z",
      "token_expires_in_minutes": 42,
      "token_scope": "LiveProfileCard.Access openid profile offline_access",
      "last_login_at": "2026-07-04T08:00:00.000Z",
      "token_captured_at": "2026-07-04T08:05:00.000Z",
      "has_refresh_token": true,
      "changed_at": "2026-07-04T08:05:00.000Z",
      "sync_version": "2026-07-04T08:05:00.000Z"
    }
  ]
}
```

### Example (curl)

```bash
curl -s -X POST "$BASE/api/v1/sync/bulk" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"emails":["user1@outlook.com","user2@outlook.com"]}'
```

### Recommended usage

- During a job, sync **50–100 emails per batch** (split larger lists into chunks).
- Use `not_found` to detect accounts missing from the server.
- Prefer `include_refresh_token: false` unless you explicitly need refresh tokens.

---

## 2. Delta sync (incremental pull)

Return only accounts **changed since** your last sync watermark.

```http
GET /api/v1/sync/delta?since=2026-07-04T06:00:00.000Z&target=outlook
Authorization: Bearer YOUR_API_KEY
```

### Query parameters

| Param | Required | Description |
|-------|----------|-------------|
| `since` | **yes** | ISO-8601 UTC timestamp from your last successful sync |
| `target` | no | Default `outlook` |
| `group` | no | Filter to one group name |
| `limit` | no | Max rows per response (default **500**, max 2000) |
| `include_refresh_token` | no | `true` / `1` to include refresh tokens |

### Response

```json
{
  "ok": true,
  "since": "2026-07-04T06:00:00.000Z",
  "server_time": "2026-07-04T09:00:00.000Z",
  "count": 12,
  "total_matched": 12,
  "has_more": false,
  "next_since": "2026-07-04T08:55:00.000Z",
  "accounts": [ /* same shape as bulk */ ]
}
```

### Watermark strategy

1. First sync: `since=1970-01-01T00:00:00.000Z` (or your app install time).
2. Store `next_since` from the response (or the max `changed_at` you processed).
3. Next poll: `since=<stored watermark>`.
4. If `has_more: true`, call again with `since=next_since` until caught up.

`changed_at` / `sync_version` updates when:

- Token is captured or refreshed
- Login / profile save
- Group assignment changes

### Example loop (pseudo-code)

```javascript
let watermark = loadWatermark() || '1970-01-01T00:00:00.000Z';

async function syncDelta() {
  for (;;) {
    const res = await fetch(`${BASE}/api/v1/sync/delta?since=${encodeURIComponent(watermark)}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    for (const acc of data.accounts) {
      upsertLocalAccount(acc);
    }

    watermark = data.next_since;
    saveWatermark(watermark);

    if (!data.has_more) break;
  }
}
```

### Polling interval

- **With webhooks:** delta poll every 15–60 min as backup only.
- **Without webhooks:** delta poll every 2–5 min during active jobs, less often when idle.

---

## 3. Webhooks (push on token update)

When the server refreshes or captures a token (login, manual refresh, smart refresh), it POSTs to your registered URL.

### Event

| Event | When fired |
|-------|------------|
| `account.token_updated` | New access token saved for an account |

### Register webhook (API)

```http
POST /api/v1/sync/webhooks
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY
```

```json
{
  "url": "https://your-app.com/hooks/headless-login",
  "events": ["account.token_updated"],
  "secret": "optional-hmac-secret",
  "label": "production worker"
}
```

Response: `{ "ok": true, "webhook": { "id", "url", "events", "created_at" } }`

### Register via environment (single URL)

In server `.env`:

```env
SYNC_WEBHOOK_URL=https://your-app.com/hooks/headless-login
SYNC_WEBHOOK_SECRET=optional-hmac-secret
```

Registered automatically on server start (id: `env-default`).

### List / delete

```http
GET /api/v1/sync/webhooks
DELETE /api/v1/sync/webhooks/{id}
```

### Webhook payload

```json
{
  "event": "account.token_updated",
  "at": "2026-07-04T09:12:00.000Z",
  "reason": "token_refresh",
  "email": "user@outlook.com",
  "target": "outlook",
  "account": {
    "email": "user@outlook.com",
    "has_token": true,
    "access_token": "EwA...",
    "token_expires_at": "2026-07-04T10:12:00.000Z",
    "health": "available",
    "session_valid": true
  }
}
```

`reason` is one of: `token_refresh`, `login`

### Signature verification

If a `secret` was set, the server sends:

```http
X-Sync-Event: account.token_updated
X-Sync-Signature: <hmac-sha256-hex of raw JSON body>
```

Verify (Node example):

```javascript
import crypto from 'node:crypto';

function verify(rawBody, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

### Recommended handler

```javascript
app.post('/hooks/headless-login', express.raw({ type: 'application/json' }), (req, res) => {
  const raw = req.body.toString();
  const sig = req.headers['x-sync-signature'];
  if (SECRET && !verify(raw, sig, SECRET)) return res.status(401).end();

  const payload = JSON.parse(raw);
  if (payload.event === 'account.token_updated') {
    upsertLocalAccount(payload.account);
    // No need to bulk-fetch this email — you already have the latest token
  }
  res.status(200).json({ ok: true });
});
```

---

## Integration patterns

### Pattern A — Job worker (best for 1k+ accounts)

1. Register webhook once.
2. On `account.token_updated`, update that email in your DB.
3. Every 30 min, run `sync/delta` as a safety net.
4. When your job needs tokens for a batch, use `sync/bulk` for that batch only.

### Pattern B — Webhook + delta only

1. Webhook for real-time updates.
2. `sync/delta` on app startup to catch missed events.

### Pattern C — No webhook (simplest)

1. Store `next_since` watermark.
2. Poll `sync/delta` every few minutes.
3. Use `sync/bulk` when you need specific emails mid-job.

---

## Errors

| HTTP | Meaning |
|------|---------|
| 400 | Invalid `since`, empty `emails`, or bulk > 100 |
| 401 | Missing/invalid API key |
| 503 | `API_KEY` not configured on server |

---

## Environment tuning

```env
SYNC_BULK_MAX=100
SYNC_DELTA_LIMIT=500
SYNC_WEBHOOK_URL=
SYNC_WEBHOOK_SECRET=
```

---

## Endpoint summary

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/sync/bulk` | Batch token lookup (≤100 emails) |
| GET | `/api/v1/sync/delta` | Changed accounts since `since` |
| GET | `/api/v1/sync/webhooks` | List webhooks |
| POST | `/api/v1/sync/webhooks` | Register webhook |
| DELETE | `/api/v1/sync/webhooks/:id` | Remove webhook |
| GET | `/api/v1/sync/events` | Supported event names |

Existing endpoints (`/api/v1/tokens`, `/api/v1/accounts/:email`, refresh) are unchanged.
