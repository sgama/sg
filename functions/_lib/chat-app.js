import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { CONFIG } from '../../shared/ai/application.js';
import { AppError, requireVectorizeBinding } from './worker-errors.js';
import { ChatRequestSchema, SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext } from './validation.js';
import { createSseMessageStream, DONE_PAYLOAD } from '../../shared/ai/chat-stream.js';
import { AiService } from './ai.js';
import { workersCacheStore } from './retrieval-cache.js';

/**
 * One chat turn: retrieve context, announce evidence, then either abstain or
 * generate. Returns the answer stream. Events leave through `emit`, so the route owns the transport.
 */
async function defaultAnswerChat({ aiService, query, history, emit }) {
    const { contextText, evidence } = await aiService.retrieve(query, history, (stage) => emit({ progress: stage }));
    await emit({ evidence });

    if (shouldAbstainForMissingContext(contextText)) {
        return createSseMessageStream(SAFE_NO_CONTEXT_MESSAGE, aiService.responseMetrics({ abstained: true }));
    }
    await emit({ progress: 'generation' });
    return aiService.generateStream(query, contextText, history);
}

const BODY_LIMIT_BYTES = 64 * 1024;
// Upper bound for one chat turn (rewrite, embedding, search and the streamed answer).
const REQUEST_DEADLINE_MS = 60_000;
const ALLOWED_ORIGINS = ['https://samsongama.com', 'https://www.samsongama.com'];

// Uses the Workers Cache API for retrieval results when it exists (it does not in plain Node).
const defaultCreateAiService = (env, signal) =>
    new AiService(env, { retrievalStore: typeof caches !== 'undefined' ? workersCacheStore(caches.default) : null, signal });

/**
 * Builds the /api/chat app. Every collaborator is injectable, so the route can run with another
 * AI service, cache store, chat flow or origin list without touching the handler.
 */
export function createChatApp({ createAiService = defaultCreateAiService, answerChat = defaultAnswerChat, allowedOrigins = ALLOWED_ORIGINS } = {}) {
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
            const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(REQUEST_DEADLINE_MS)]);
            const aiService = createAiService(env, signal);
            requireVectorizeBinding(env.VECTORIZE_INDEX);
            return streamSSE(c, async (sse) => {
                try {
                    const stream = await answerChat({
                        aiService,
                        query,
                        history,
                        emit: (payload) => sse.writeSSE({ data: JSON.stringify(payload) }),
                    });
                    await sse.pipe(stream);
                } catch (err) {
                    console.error('Chat Request Failed:', err);
                    if (!sse.aborted) {
                        await sse.writeSSE({
                            data: JSON.stringify({ error: err instanceof AppError ? err.message : 'The response could not be completed.' }),
                        });
                        await sse.writeSSE({ data: DONE_PAYLOAD });
                    }
                }
            });
        },
    );

    return app;
}
