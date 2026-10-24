import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { handle } from 'hono/cloudflare-pages';
import { AppError, CONFIG } from '../_lib/application.js';
import { isPromptInjectionAttempt, ChatRequestSchema } from '../_lib/validation.js';
import { AiService } from '../_lib/ai.js';
import { workersCacheStore } from '../_lib/retrieval-cache.js';
import { answerChat } from '../_lib/chat-flow.js';

const ALLOWED_ORIGINS = ['https://samsongama.com', 'https://www.samsongama.com'];

const app = new Hono();

app.use(
    '/api/chat',
    cors({
        origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
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

    const aiService = new AiService(env, { retrievalStore: typeof caches !== 'undefined' ? workersCacheStore(caches.default) : null });
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

export const onRequest = handle(app);
