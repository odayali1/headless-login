# Headless Login — External API (v1)

**Production:** `https://acc-api-dashboeard.34.166.92.24.sslip.io`  
**Local:** `http://localhost:3847`

All `/api/v1/*` routes require an API key. The dashboard UI does **not** need the key (except data restore upload).

## Setup

Set in `.env` (min 16 characters):

```env
API_KEY=your-long-random-secret
```

Send on every request:

```http
Authorization: Bearer YOUR_API_KEY
```

or:

```http
X-API-Key: YOUR_API_KEY
```

---

## Endpoints

### Health

```http
GET /api/v1/health
```

Response: `{ ok, api, auth, queue, jobs }`

---

### List all accounts + tokens

```http
GET /api/v1/tokens?target=outlook
```

| Query | Default | Description |
|-------|---------|-------------|
| `target` | `outlook` | `outlook` or `teams` |
| `group` | — | Filter by group name |
| `health` | — | e.g. `available`, `session_only`, `failed` |
| `tokens_only` | `true` | Set `0` to include accounts without a valid token |
| `include_refresh_token` | `false` | Set `1` to include `refresh_token` in JSON |

**Example response:**

```json
{
  "ok": true,
  "count": 2,
  "accounts": [
    {
      "email": "user@outlook.com",
      "target": "outlook",
      "group": "client-x",
      "health": "available",
      "has_token": true,
      "access_token": "EwA...",
      "token_expires_at": "2026-06-27T12:00:00.000Z",
      "token_expires_in_minutes": 45,
      "last_login_at": "2026-06-27T10:00:00.000Z",
      "session_valid": true
    }
  ]
}
```

---

### Single account

```http
GET /api/v1/accounts/user@outlook.com?target=outlook
```

---

### Refresh token (queue)

Opens Camoufox with the **saved profile** (no password re-entry). Renews `LiveProfileCard.Access` via refresh_token / MSAL — **not a full re-login**.

```http
POST /api/v1/accounts/user@outlook.com/refresh
Content-Type: application/json

{"target": "outlook"}
```

Response `202`:

```json
{
  "ok": true,
  "email": "user@outlook.com",
  "target": "outlook",
  "job_id": "uuid",
  "status": "queued",
  "poll_url": "/api/v1/jobs/uuid"
}
```

Duplicate refresh for the same account returns the existing job id (`duplicate: true`).

### Refresh and wait (sync)

```http
POST /api/v1/accounts/user@outlook.com/refresh?wait=true&timeout_ms=120000
```

Waits up to 120s (max 300s). On success returns updated `account` with new token.

### Poll job status

```http
GET /api/v1/jobs/{job_id}
```

---

## Refresh vs Re-login

| | **Refresh token** | **Re-login** |
|---|-------------------|--------------|
| Password | Not used | Uses saved password |
| Browser | Camoufox + saved profile | Full Microsoft sign-in flow |
| When to use | Token expired, session still valid | Session dead, MFA, session-only |

## Proxy on refresh

When proxy is **ON** (default):

- Every refresh uses the mobile SOCKS5 proxy (via local relay).
- IP **rotates every 5 account operations** (logins + refreshes that call `beforeAccountLogin`), not on every single refresh.

---

## Errors

| Code | Meaning |
|------|---------|
| 401 | Bad/missing API key |
| 404 | Account not found |
| 400 | No valid session (re-login first) |
| 422 | Refresh job finished failed |
| 504 | `wait=true` timed out |
| 503 | `API_KEY` not configured on server |

---

## cURL examples

```bash
export BASE=https://acc-api-dashboeard.34.166.92.24.sslip.io
export KEY=your-api-key

# All tokens
curl -s -H "Authorization: Bearer $KEY" "$BASE/api/v1/tokens" | jq .

# Refresh async
curl -s -X POST -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"target":"outlook"}' \
  "$BASE/api/v1/accounts/user@outlook.com/refresh"

# Poll job
curl -s -H "Authorization: Bearer $KEY" "$BASE/api/v1/jobs/JOB_ID"
```

---

## Restore data backup (Coolify / server)

Upload your laptop `data-backup.zip` into persistent `/app/data`:

**Dashboard:** Account dashboard → **Restore data backup** → enter API key → choose zip → Upload.

**API:**

```http
POST /api/data/import
Authorization: Bearer YOUR_API_KEY
Content-Type: application/zip

<raw zip bytes>
```

Server extracts `app.db` + `profiles/` then auto-restarts. `CREDENTIALS_KEY` on the server must match the laptop backup.

---

## CSV export (dashboard)

Unauthenticated browser download:

- `GET /api/accounts/export/tokens` — columns: `email`, `access_token`, `last_login`, `token_expires`, `health`, `group`
- `GET /api/accounts/export/failed-refresh` — failed accounts with refresh_token
