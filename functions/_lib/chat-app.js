import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { CONFIG } from '../../shared/ai/application.js';
import { isDeadlineAbort } from '../../shared/ai/abort.js';
import { DONE_PAYLOAD } from '../../shared/ai/chat-stream.js';
import { runTurn as defaultRunTurn } from './agent.js';
import { ChatRequestSchema } from './validation.js';
import { AppError, requireSearchBinding } from './worker-errors.js';

const BODY_LIMIT_BYTES = 64 * 1024;
// Upper bound for one chat turn (the model's search steps and the streamed answer).
const REQUEST_DEADLINE_MS = 60_000;
const ALLOWED_ORIGINS = ['https://samsongama.com', 'https://www.samsongama.com'];

/**
 * Builds the /api/chat app. Every collaborator is injectable, so the route can run with another
 * chat turn (`runTurn` returns an async iterable of wire events) or origin list without touching the handler.
 */
export function createChatApp({ runTurn = defaultRunTurn, allowedOrigins = ALLOWED_ORIGINS } = {}) {
    const app = /** @type {Hono<{ Bindings: Env }>} */ (new Hono());

    // www and the apex are one site, so same-site (not the same-origin default) keeps CORS-allowed calls readable.
    app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-site' }));

    // AppError and HTTPException messages are already client-safe; anything else is logged and reported as a generic 500.
    app.onError((err, c) => {
        if (err instanceof AppError || err instanceof HTTPException) return c.json({ error: err.message }, err.status);
        console.error('API Fatal', { error: err, method: c.req.method, route: c.req.url, cause: err?.cause });
        return c.json({ error: 'Internal Server Error' }, 500);
    });

    app.use(
        '/api/chat',
        cors({
            origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
            allowMethods: ['POST', 'OPTIONS'],
            allowHeaders: ['Content-Type'],
            maxAge: 86400,
        }),
    );

    app.post(
        '/api/chat',
        async (c, next) => {
            const key = c.req.header('cf-connecting-ip') ?? 'unknown';
            if (c.env?.CHAT_LIMITER && !(await c.env.CHAT_LIMITER.limit({ key })).success) {
                return c.json({ error: 'Too many requests. Please wait a minute and try again.' }, 429);
            }
            await next();
        },
        bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: (c) => c.json({ error: 'Request body too large.' }, 413) }),
        zValidator('json', ChatRequestSchema, (result, c) => {
            if (!result.success) return c.json({ error: `Invalid query. Must be a string < ${CONFIG.QUERY.MAX_LENGTH} chars.` }, 400);
        }),
        async (c) => {
            const env = c.env;

            const { query, history } = c.req.valid('json');

            if (!env?.AI) {
                return c.json({ error: 'Service Unavailable: AI binding missing' }, 503);
            }

            // The client disconnecting or the deadline passing aborts every paid model call for this turn.
            const requestSignal = c.req.raw.signal;
            if (requestSignal?.aborted) return new Response('', { status: 200 });
            const deadlineSignal = AbortSignal.timeout(REQUEST_DEADLINE_MS);
            const signal = AbortSignal.any([requestSignal, deadlineSignal]);
            requireSearchBinding(env);
            return streamSSE(c, async (sse) => {
                try {
                    for await (const event of runTurn({ env, query, history, signal })) {
                        if (sse.aborted || signal.aborted) return;
                        await sse.writeSSE({ data: JSON.stringify(event) });
                    }
                    await sse.writeSSE({ data: DONE_PAYLOAD });
                } catch (err) {
                    if (requestSignal.aborted) return;
                    if (!isDeadlineAbort(signal, deadlineSignal)) console.error('Chat Request Failed:', err);
                    if (sse.aborted) return;
                    const message = err instanceof AppError && !signal.aborted ? err.message : 'The response could not be completed.';
                    await sse.writeSSE({ data: JSON.stringify({ error: message }) });
                    await sse.writeSSE({ data: DONE_PAYLOAD });
                }
            });
        },
    );

    return app;
}
