import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { handle } from 'hono/cloudflare-pages';
import { AppError } from '../_lib/application.js';
import { isPromptInjectionAttempt, SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext, ChatRequestSchema } from '../_lib/validation.js';
import { createSseMessageStream } from '../_lib/chat-stream.js';
import { AiService } from '../_lib/ai.js';
import { LogService } from '../_lib/log.js';

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
        return c.json({ error: 'Invalid query. Must be a string < 500 chars.' }, 400);
    }
    const { query, history } = parsed.data;

    if (isPromptInjectionAttempt(query)) {
        return c.json({ error: 'Query rejected by guardrails.' }, 400);
    }

    if (!env?.AI) {
        return c.json({ error: 'Service Unavailable: AI binding missing' }, 503);
    }

    const aiService = new AiService(env);
    if (!env.VECTORIZE_INDEX) {
        console.error('Vector Search Failed: VECTORIZE_INDEX binding missing');
        throw new AppError('Retrieval service unavailable', 503);
    }
    c.header('X-Content-Type-Options', 'nosniff');
    return streamSSE(c, async (sse) => {
        try {
            const contextText = await aiService.retrieveContext(query, history, (stage) =>
                sse.writeSSE({ data: JSON.stringify({ progress: stage }) }),
            );
            await sse.writeSSE({ data: JSON.stringify({ evidence: aiService.evidence }) });
            let stream;
            if (shouldAbstainForMissingContext(contextText)) {
                stream = createSseMessageStream(SAFE_NO_CONTEXT_MESSAGE, aiService.responseMetrics({ abstained: true }));
            } else {
                await sse.writeSSE({ data: JSON.stringify({ progress: 'generation' }) });
                stream = await aiService.generateStream(query, contextText, history);
            }
            if (env.CHAT_LOGS) stream = await LogService.save(env.CHAT_LOGS, query, stream, c.executionCtx);
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
