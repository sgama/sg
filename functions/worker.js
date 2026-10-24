import { Hono } from 'hono';
import { createChatApp } from './_lib/chat-app.js';
import { createLogsApp } from './_lib/logs-app.js';

// The Worker serves only the API. wrangler.toml sets assets.run_worker_first to /api/*, so Cloudflare serves the static
// site directly and invokes this Worker for API paths alone.
const app = /** @type {Hono<{ Bindings: Env }>} */ (new Hono());
app.route('/', createChatApp());
app.route('/', createLogsApp());

export default { fetch: app.fetch };
