import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { AppError, CONFIG, requireVectorizeBinding } from './application.js';
import { isPromptInjectionAttempt, ChatRequestSchema, SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext } from './validation.js';
import { createSseMessageStream, DONE_PAYLOAD } from './chat-stream.js';
import { AiService } from './ai.js';
import { workersCacheStore } from './retrieval-cache.js';

/**
 * One chat turn: retrieve context, announce evidence, then either abstain or
 * generate. Returns the answer stream. Events leave through `emit`, so the route owns the transport.
 */
async function defaultAnswerChat({ aiService, query, history, signal, emit }) {
    const { contextText, evidence } = await aiService.retrieve(query, history, (stage) => emit({ progress: stage }));
    await emit({ evidence });

    if (shouldAbstainForMissingContext(contextText)) {
        return createSseMessageStream(SAFE_NO_CONTEXT_MESSAGE, aiService.responseMetrics({ abstained: true }));
    }
    await emit({ progress: 'generation' });
    return aiService.generateStream(query, contextText, history, { signal });
}

const BODY_LIMIT_BYTES = 64 * 1024;
const ALLOWED_ORIGINS = ['https://samsongama.com', 'https://www.samsongama.com'];

// Uses the Workers Cache API for retrieval results when it exists (it does not in plain Node).
const defaultCreateAiService = (env) =>
    new AiService(env, { retrievalStore: typeof caches !== 'undefined' ? workersCacheStore(caches.default) : null });

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
        bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: (c) => c.json({ error: 'Request body too large.' }, 413) }),
        zValidator('json', ChatRequestSchema, (result, c) => {
            if (!result.success) return c.json({ error: `Invalid query. Must be a string < ${CONFIG.QUERY.MAX_LENGTH} chars.` }, 400);
        }),
        async (c) => {
            const env = c.env;

            const { query, history } = c.req.valid('json');

            if (isPromptInjectionAttempt(query) || history.some((message) => isPromptInjectionAttempt(message.content))) {
                return c.json({ error: 'Query rejected by guardrails.' }, 400);
            }

            if (!env?.AI) {
                return c.json({ error: 'Service Unavailable: AI binding missing' }, 503);
            }

            const aiService = createAiService(env);
            requireVectorizeBinding(env.VECTORIZE_INDEX);
            return streamSSE(c, async (sse) => {
                try {
                    const stream = await answerChat({
                        aiService,
                        query,
                        history,
                        signal: c.req.raw.signal,
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
