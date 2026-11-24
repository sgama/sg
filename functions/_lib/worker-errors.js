export class AppError extends Error {
    /**
     * @param {string} message
     * @param {import('hono/utils/http-status').ContentfulStatusCode} [status]
     */
    constructor(message, status = 500) {
        super(message);
        this.status = status;
        this.name = this.constructor.name;
    }
}

/**
 * The chat route needs the AI Search binding and the live instance name; without them it fails before SSE headers
 * with one log line and one client-facing 503.
 * @param {{ AI_SEARCH?: unknown, AI_SEARCH_INSTANCE?: string } | undefined} env
 */
export function requireSearchBinding(env) {
    if (env?.AI_SEARCH && env.AI_SEARCH_INSTANCE) return;
    console.error('AI Search Failed: AI_SEARCH binding or AI_SEARCH_INSTANCE missing');
    throw new AppError('Retrieval service unavailable', 503);
}
