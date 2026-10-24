# Public Chat API

Intentionally public for this demo (transcripts may be read publicly; no authentication). No rate limiting is implemented — programmatic consumers should keep request rates low.

## `POST /api/chat`

RAG chat over public site content, streaming Server-Sent Events.

### Request

- CORS: `https://samsongama.com` and `https://www.samsongama.com` only; methods `POST`/`OPTIONS`; header `Content-Type`.
- Body (`application/json`):

```json
{
    "query": "What infrastructure has Samson managed?", // required, trimmed, 1-500 chars
    "history": [
        { "role": "user", "content": "..." }, // max 4 turns
        { "role": "assistant", "content": "..." } // max 2000 chars each
    ] // optional; total history <= 4000 chars
}
```

- Validation failures return `400 { "error": "Invalid query. Must be a string < 500 chars." }`.
- Prompt-injection guardrails reject qualifying queries with `400 { "error": "Query rejected by guardrails." }`.
- `503 { "error": "Service Unavailable: AI binding missing" }` when the AI binding is not configured.

### Response (SSE, `text/event-stream`)

`data:` lines carrying JSON, in this order as available:

| Event      | Payload                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `progress` | `"rewrite"`, `"embedding"`, `"search"`, `"generation"` stage labels                                                  |
| `evidence` | Array of excerpts: `{ title?, url?, section?, text }` — public pages only (internal `_context` sources are excluded) |
| `response` | One incremental answer chunk (`{ "response": "..." }`)                                                               |
| `usage`    | Provider token usage for the answer                                                                                  |
| `metrics`  | `{ rewriteMs?, embeddingMs?, retrievalMs, totalMs, firstAnswerMs?, ... }` server timings                             |
| `[DONE]`   | Sentinel line ending the stream                                                                                      |

Errors after streaming starts keep HTTP 200 and surface as `data: {"error":"..."}` (paid requests are never retried automatically). Validated errors and missing-binding errors return standard HTTP error responses before the stream starts.

## `GET /api/logs`

Public, unauthenticated transcript listing (`Cache-Control: no-store`). No CORS headers (same-origin usage).

### Request

- `limit` — integer 1-50, default `20` (invalid/over-max values fall back to `20`)
- `cursor` — opaque pagination token from the previous response's `meta.cursor`
- Non-get methods (`POST`/`PUT`/`DELETE`/`PATCH`) return `405 { "error": "Method not allowed" }`.
- `503 { "error": "Service Unavailable: KV binding missing" }` when the KV binding is not configured.

### Response

```json
{
  "data": [
    { "id": "chat:2026-10-23T...", "timestamp": "...", "query": "...", "response": "...", "usage": {...}, "error": "optional" }
  ],
  "meta": { "count": 20, "limit": 20, "cursor": "opaque", "has_more": true }
}
```

Records older than 30 days expire from the store. Log records saved under unsupported versions are skipped and logged server-side rather than failing the listing.

## Discoverability

- Root `llms.txt` indexes the site for agents; `llms-full.txt` carries full page text.
- `robots.txt` explicitly allows AI crawlers (site content is open); `/api/` paths are excluded from crawler crawling.
