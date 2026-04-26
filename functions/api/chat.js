import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { handle } from 'hono/cloudflare-pages';
import { AppError } from '../_lib/config.js';
import {
    createSseMessageStream,
    isPromptInjectionAttempt,
    SAFE_NO_CONTEXT_MESSAGE,
    shouldAbstainForMissingContext,
} from '../_lib/guardrails.js';
import { ChatRequestSchema } from '../_lib/schemas.js';
import { AiService } from '../_lib/ai.js';
import { LogService } from '../_lib/log.js';

const ALLOWED_ORIGINS = ['https://samsongama.com', 'https://www.samsongama.com'];

const app = new Hono();

app.use('/api/chat', cors({
    origin: (origin) => ALLOWED_ORIGINS.includes(origin) ? origin : null,
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 86400,
}));

app.post('/api/chat', async (c) => {
    const env = c.env;

    const parsed = ChatRequestSchema.safeParse(
        await c.req.json().catch(() => ({}))
    );
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
    const contextText = await aiService.retrieveContext(query);
    let stream;

    if (shouldAbstainForMissingContext(contextText)) {
        stream = createSseMessageStream(SAFE_NO_CONTEXT_MESSAGE);
    } else {
        stream = await aiService.generateStream(query, contextText, history);
    }

    if (env.CHAT_LOGS) {
        stream = await LogService.save(env.CHAT_LOGS, query, stream, c.executionCtx);
    }

    c.header('X-Content-Type-Options', 'nosniff');
    return streamSSE(c, async (sse) => {
        await sse.pipe(stream);
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
