import { CONFIG } from '../_lib/config.js';
import { LogService } from '../_lib/log.js';

/**
 * Enterprise-Grade Logs Handler
 * @file functions/api/logs.js
 */
export async function onRequest(context) {
    if (context.request.method !== "GET") {
        return createResponse({ error: "Method not allowed" }, 405);
    }

    if (!context.env.CHAT_LOGS) {
        return createResponse({ error: "Service Unavailable: KV binding missing" }, 503);
    }

    try {
        const url = new URL(context.request.url);
        const cursor = url.searchParams.get("cursor");
        const limitParam = parseInt(url.searchParams.get("limit"));

        const limit = (!isNaN(limitParam) && limitParam > 0 && limitParam <= CONFIG.PAGINATION.MAX_LIMIT)
            ? limitParam
            : CONFIG.PAGINATION.DEFAULT_LIMIT;

        const data = await LogService.fetchLogs(context.env.CHAT_LOGS, limit, cursor);

        return createResponse(data, 200);

    } catch (err) {
        console.error(`Logs API Error: ${err.message}`);
        return createResponse({ error: "Internal Server Error" }, 500);
    }
}

function createResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        }
    });
}
