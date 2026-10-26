import { Hono } from 'hono';
import { AppError } from './application.js';

/**
 * Root app for one JSON API surface: handled responses are non-sniffable, and failures keep the
 * client-visible `{ error }` shape. `AppError` is a deliberate, already-safe client message, so it is
 * passed through unlogged; anything else is logged once and reported as a generic 500.
 * @param {string} logLabel prefix for unexpected-error logs, so the failing surface is obvious
 */
export function createApiApp(logLabel) {
    const app = /** @type {Hono<{ Bindings: Env }>} */ (new Hono());

    app.use('*', async (c, next) => {
        await next();
        c.res.headers.set('X-Content-Type-Options', 'nosniff');
    });

    app.onError((err, c) => {
        if (err instanceof AppError) {
            return c.json({ error: err.message }, err.status);
        }
        console.error(`${logLabel}: ${err instanceof Error ? err.message : String(err)}`);
        return c.json({ error: 'Internal Server Error' }, 500);
    });

    return app;
}
