import { AppError, CONFIG } from '../_lib/config.js';
import { createSseMessageStream } from '../_lib/sse.js';
import {
    isPromptInjectionAttempt,
    SAFE_NO_CONTEXT_MESSAGE,
    shouldAbstainForMissingContext,
} from '../_lib/guardrails.js';
import { sanitizeHistory } from '../_lib/history.js';
import { AiService, LogService } from '../_lib/services.js';

const MAX_QUERY_LENGTH = 500;

/**
 * Enterprise-Grade Main Handler
 */
export async function onRequest(context) {
    // 1. Preflight & Method Check
    if (context.request.method === "OPTIONS") {
        return new Response(null, { headers: getCorsHeaders() });
    }
    if (context.request.method !== "POST") {
        return createErrorResponse("Method not allowed", 405);
    }

    try {
        // 2. Input Validation
        const body = await context.request.json().catch(() => ({}));
        const query = typeof body.query === 'string' ? body.query.trim() : '';
        if (!query || query.length > MAX_QUERY_LENGTH) {
            return createErrorResponse("Invalid query. Must be a string < 500 chars.", 400);
        }
        if (isPromptInjectionAttempt(query)) {
            return createErrorResponse("Query rejected by guardrails.", 400);
        }

        if (!context.env?.AI) {
            throw new AppError("Service Unavailable: AI binding missing", 503);
        }

        const history = sanitizeHistory(body.history, {
            maxTurns: CONFIG.HISTORY.MAX_TURNS,
            maxContentLength: CONFIG.HISTORY.MAX_CONTENT_LENGTH,
        });

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
                ...getCorsHeaders(),
                ...getCommonHeaders(),
                "Content-Type": "text/event-stream; charset=utf-8"
            }
        });

    } catch (err) {
        if (err instanceof AppError) {
            return createErrorResponse(err.message, err.status);
        }

        console.error(`API Fatal: ${err.message}`);
        return createErrorResponse("Internal Server Error", 500);
    }
}

function getCorsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
    };
}

function getCommonHeaders() {
    return {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    };
}

function createErrorResponse(msg, status) {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: {
            ...getCorsHeaders(),
            ...getCommonHeaders(),
            "Content-Type": "application/json; charset=utf-8"
        }
    });
}
