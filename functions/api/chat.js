import { AppError } from '../_lib/config.js';
import { createSseMessageStream } from '../_lib/guardrails.js';
import {
    isPromptInjectionAttempt,
    SAFE_NO_CONTEXT_MESSAGE,
    shouldAbstainForMissingContext,
} from '../_lib/guardrails.js';
import { ChatRequestSchema } from '../_lib/schemas.js';
import { AiService } from '../_lib/ai.js';
import { LogService } from '../_lib/log.js';

const ALLOWED_ORIGINS = new Set([
    "https://samsongama.com",
    "https://www.samsongama.com",
]);

const COMMON_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
};

function corsHeaders(origin) {
    if (!ALLOWED_ORIGINS.has(origin)) return {};
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
    };
}

export async function onRequest(context) {
    const origin = context.request.headers.get("Origin") ?? "";
    const cors = corsHeaders(origin);

    // 1. Preflight & Method Check
    if (context.request.method === "OPTIONS") {
        if (!ALLOWED_ORIGINS.has(origin)) {
            return new Response(null, { status: 403 });
        }
        return new Response(null, { headers: cors });
    }
    if (context.request.method !== "POST") {
        return createErrorResponse("Method not allowed", 405, cors);
    }

    try {
        // 2. Input Validation
        const parsed = ChatRequestSchema.safeParse(
            await context.request.json().catch(() => ({}))
        );
        if (!parsed.success) {
            return createErrorResponse("Invalid query. Must be a string < 500 chars.", 400);
        }
        const { query, history } = parsed.data;

        if (isPromptInjectionAttempt(query)) {
            return createErrorResponse("Query rejected by guardrails.", 400);
        }

        if (!context.env?.AI) {
            throw new AppError("Service Unavailable: AI binding missing", 503);
        }

        // 4. Service Orchestration
        const aiService = new AiService(context.env);
        const contextText = await aiService.retrieveContext(query);
        let stream;

        if (shouldAbstainForMissingContext(contextText)) {
            stream = createSseMessageStream(SAFE_NO_CONTEXT_MESSAGE);
        } else {
            stream = await aiService.generateStream(query, contextText, history);
        }

        // 5. Logging Hook (Middleware-like)
        if (context.env.CHAT_LOGS) {
            // Persist the complete chat interaction to KV for history
            stream = await LogService.save(context.env.CHAT_LOGS, query, stream, context);
        }

        return new Response(stream, {
            headers: {
                ...cors,
                ...COMMON_HEADERS,
                "Content-Type": "text/event-stream; charset=utf-8"
            }
        });

    } catch (err) {
        if (err instanceof AppError) {
            return createErrorResponse(err.message, err.status, cors);
        }

        console.error(`API Fatal: ${err.message}`);
        return createErrorResponse("Internal Server Error", 500, cors);
    }
}

function createErrorResponse(msg, status, cors = {}) {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: {
            ...cors,
            ...COMMON_HEADERS,
            "Content-Type": "application/json; charset=utf-8"
        }
    });
}
