import { Hono } from 'hono';
import { CONFIG } from './application.js';
import { fetchChatLogs } from './log.js';

/** The public transcript API: GET /api/logs with cursor pagination. */
export function createLogsApp() {
    const app = /** @type {Hono<{ Bindings: Env }>} */ (new Hono());

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

        const cursor = typeof c.req.query('cursor') === 'string' ? c.req.query('cursor') : undefined;
        const limitParam = Number.parseInt(c.req.query('limit') ?? '', 10);
        const limit =
            Number.isInteger(limitParam) && limitParam > 0 && limitParam <= CONFIG.PAGINATION.MAX_LIMIT
                ? limitParam
                : CONFIG.PAGINATION.DEFAULT_LIMIT;

        const data = await fetchChatLogs(env, limit, cursor);
        return c.json(data);
    });

    app.onError((err, c) => {
        console.error(`Logs API Error: ${err.message}`);
        return c.json({ error: 'Internal Server Error' }, 500);
    });

    return app;
}
