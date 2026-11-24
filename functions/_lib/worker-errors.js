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
 * Both the request path and the service fail the same way when the Vectorize binding is absent: one
 * log line and one client-facing 503. The request path checks early so it fails before SSE headers.
 * @param {unknown} vectorize
 */
export function requireVectorizeBinding(vectorize) {
    if (vectorize) return;
    console.error('Vector Search Failed: VECTORIZE_INDEX binding missing');
    throw new AppError('Retrieval service unavailable', 503);
}
