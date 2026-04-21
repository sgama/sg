import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';
import { CONFIG } from '../_lib/config.js';
import { LogService } from '../_lib/log.js';

const app = new Hono();

app.use('/api/logs', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
});

app.on(['POST', 'PUT', 'DELETE', 'PATCH'], '/api/logs', (c) => {
    return c.json({ error: 'Method not allowed' }, 405);
});

app.get('/api/logs', async (c) => {
    const env = c.env;

    if (!env.CHAT_LOGS) {
        return c.json({ error: 'Service Unavailable: KV binding missing' }, 503);
    }

    const cursor = c.req.query('cursor') ?? undefined;
    const limitParam = parseInt(c.req.query('limit'));
    const limit = (!isNaN(limitParam) && limitParam > 0 && limitParam <= CONFIG.PAGINATION.MAX_LIMIT)
        ? limitParam
        : CONFIG.PAGINATION.DEFAULT_LIMIT;

    const data = await LogService.fetchLogs(env.CHAT_LOGS, limit, cursor);
    return c.json(data);
});

app.onError((err, c) => {
    console.error(`Logs API Error: ${err.message}`);
    return c.json({ error: 'Internal Server Error' }, 500);
});

export const onRequest = handle(app);

