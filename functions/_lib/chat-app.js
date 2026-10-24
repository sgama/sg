import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { AppError, CONFIG } from './application.js';
import { isPromptInjectionAttempt, ChatRequestSchema, SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext } from './validation.js';
import { createSseMessageStream } from './chat-stream.js';
import { saveChatLog } from './log.js';
import { AiService } from './ai.js';
import { workersCacheStore } from './retrieval-cache.js';

/**
 * One chat turn: retrieve context, announce evidence, then either abstain or
 * generate. Returns the answer stream, wrapped for logging when a log store is
 * bound. Events leave through `emit`, so the route owns the transport.
 */
async function defaultAnswerChat({ aiService, env, executionCtx, query, history, emit }) {
    const { contextText, evidence } = await aiService.retrieve(query, history, (stage) => emit({ progress: stage }));
    await emit({ evidence });

    let stream;
    if (shouldAbstainForMissingContext(contextText)) {
        stream = createSseMessageStream(SAFE_NO_CONTEXT_MESSAGE, aiService.responseMetrics({ abstained: true }));
    } else {
        await emit({ progress: 'generation' });
        stream = await aiService.generateStream(query, contextText, history);
    }
    return env.CHAT_LOGS ? saveChatLog(env, query, stream, executionCtx) : stream;
}

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

    app.use(
        '/api/chat',
        cors({
            origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
            allowMethods: ['POST', 'OPTIONS'],
            allowHeaders: ['Content-Type'],
            maxAge: 86400,
        }),
    );

    app.post('/api/chat', async (c) => {
        const env = c.env;

        const parsed = ChatRequestSchema.safeParse(await c.req.json().catch(() => ({})));
        if (!parsed.success) {
            return c.json({ error: `Invalid query. Must be a string < ${CONFIG.QUERY.MAX_LENGTH} chars.` }, 400);
        }
        const { query, history } = parsed.data;

        if (isPromptInjectionAttempt(query)) {
            return c.json({ error: 'Query rejected by guardrails.' }, 400);
        }

        if (!env?.AI) {
            return c.json({ error: 'Service Unavailable: AI binding missing' }, 503);
        }

        const aiService = createAiService(env);
        if (!env.VECTORIZE_INDEX) {
            console.error('Vector Search Failed: VECTORIZE_INDEX binding missing');
            throw new AppError('Retrieval service unavailable', 503);
        }
        c.header('X-Content-Type-Options', 'nosniff');
        return streamSSE(c, async (sse) => {
            try {
                const stream = await answerChat({
                    aiService,
                    env,
                    executionCtx: c.executionCtx,
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
                    await sse.writeSSE({ data: '[DONE]' });
                }
            }
        });
    });

    app.onError((err, c) => {
        if (err instanceof AppError) {
            return c.json({ error: err.message }, err.status);
        }
        console.error(`API Fatal: ${err.message}`);
        return c.json({ error: 'Internal Server Error' }, 500);
    });

    return app;
}
