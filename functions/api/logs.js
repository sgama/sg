/**
 * @file functions/api/logs.js
 * @description Public, paginated endpoint to retrieve chat logs from KV storage.
 */

const CONFIG = {
    DEFAULT_LIMIT: 20,
    MAX_LIMIT: 50,
    KV_PREFIX: "chat:",
};

/**
 * Main Request Handler
 * Implements: Validation -> Auth -> Service Call -> Response Formatting
 * 
 * @param {EventContext} context 
 * @returns {Response}
 */
export async function onRequest(context) {
    // 1. Method Validation
    if (context.request.method !== "GET") {
        return createResponse({ error: "Method not allowed" }, 405);
    }

    // 2. Dependency Check
    if (!context.env.CHAT_LOGS) {
        return createResponse({ error: "Service Unavailable: KV binding missing" }, 503);
    }

    try {
        // 4. Parameter Parsing
        const url = new URL(context.request.url);
        const cursor = url.searchParams.get("cursor");
        const limitParam = parseInt(url.searchParams.get("limit"));
        const limit = (!isNaN(limitParam) && limitParam > 0 && limitParam <= CONFIG.MAX_LIMIT)
            ? limitParam
            : CONFIG.DEFAULT_LIMIT;

        // 5. Service Execution
        const data = await LogsService.fetchLogs(context.env.CHAT_LOGS, limit, cursor);

        // 6. Response
        return createResponse(data, 200);

    } catch (err) {
        console.error(`Logs API Error: ${err.message}`);
        return createResponse({ error: "Internal Server Error" }, 500);
    }
}

/**
 * Service Layer: Encapsulates Data Access Logic
 */
class LogsService {
    /**
     * Fetches formatted logs from KV
     * @param {KVNamespace} kv 
     * @param {number} limit 
     * @param {string|null} cursor 
     */
    static async fetchLogs(kv, limit, cursor) {
        // A. List Keys (Pagination handled by KV)
        const listOptions = {
            prefix: CONFIG.KV_PREFIX,
            limit: limit,
            ...(cursor && { cursor })
        };

        const listResult = await kv.list(listOptions);

        // B. Data Hydration (N+1 Fetch pattern)
        // Note: In a true high-scale enterprise scenario, we would use Analytics Engine 
        // or D1 for this. For KV, concurrent fetches are the standard pattern.
        const logs = await Promise.all(
            listResult.keys.reverse().map(async (key) => {
                const value = await kv.get(key.name, { type: "json" });
                return {
                    id: key.name,
                    ...value
                };
            })
        );

        return {
            data: logs,
            meta: {
                count: logs.length,
                cursor: listResult.cursor,
                has_more: !listResult.list_complete
            }
        };
    }
}

/**
 * Response Factory
 * Standardizes JSON response format and CORS headers
 */
function createResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*", // Configure strictly for prod
            "Cache-Control": "no-store" // Logs should not be cached
        }
    });
}
