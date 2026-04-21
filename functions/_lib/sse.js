/**
 * Shared SSE stream helpers. Used by the chat handler and guardrails.
 */

const encoder = new TextEncoder();

/**
 * Wrap a plain-text message as a minimal two-frame SSE ReadableStream:
 *   data: {"response":"<message>"}\n\n
 *   data: [DONE]\n\n
 */
export function createSseMessageStream(message) {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: message })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        }
    });
}
