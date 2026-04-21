import { AppError, CONFIG } from '../_lib/config.js';
import { sanitizeHistory } from '../_lib/history.js';
import { AiService, LogService } from '../_lib/services.js';

/**
 * Enterprise-Grade Main Handler
 */
export async function onRequest(context) {
    // 1. Prefligth & Method Check
    if (context.request.method === "OPTIONS") {
        return new Response(null, { headers: getCorsHeaders() });
    }
    if (context.request.method !== "POST") {
        return createErrorResponse("Method not allowed", 405);
    }

    try {
        // 2. Input Validation
        const body = await context.request.json().catch(() => ({}));
        if (!body.query || typeof body.query !== 'string' || body.query.length > 500) {
            return createErrorResponse("Invalid query. Must be a string < 500 chars.", 400);
        }

        const history = sanitizeHistory(body.history, {
            maxTurns: CONFIG.HISTORY.MAX_TURNS,
            maxContentLength: CONFIG.HISTORY.MAX_CONTENT_LENGTH,
        });

        // 4. Service Orchestration
        const aiService = new AiService(context.env);
        const contextText = await aiService.retrieveContext(body.query);
        let stream = await aiService.generateStream(body.query, contextText, history);

        // 5. Logging Hook (Middleware-like)
        if (context.env.CHAT_LOGS) {
            // Persist the complete chat interaction to KV for history
            stream = await LogService.save(context.env.CHAT_LOGS, body.query, stream, context);
        }

        return new Response(stream, {
            headers: {
                ...getCorsHeaders(),
                "Content-Type": "text/event-stream"
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
    };
}

function createErrorResponse(msg, status) {
    return new Response(JSON.stringify({ error: msg }), {
        status,
        headers: { ...getCorsHeaders(), "Content-Type": "application/json" }
    });
}
