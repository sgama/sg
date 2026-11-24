/** Terminal payload; the SSE framing around it is the route's concern, the token itself is the wire contract. */
export const DONE_PAYLOAD = '[DONE]';

const OUTPUT_PARTS = new Set(['reasoning-delta', 'text-delta', 'tool-call', 'tool-result']);

/**
 * True for stream parts a visitor could already have seen; a failure after one of these can no longer be retried
 * on another model without repeating output.
 * @param {{ type: string }} part
 */
export const isOutputPart = (part) => OUTPUT_PARTS.has(part.type);

/**
 * Maps `streamText().fullStream` parts to the widget's wire events: `{ progress }`, `{ evidence }`, `{ response }`,
 * `{ usage }` and a final `{ metrics }`. Failures and aborts throw, so the caller owns the `{ error }` + `[DONE]` ending.
 * A `{ type: 'model', model }` part (see runWithFallback) names the model that is answering.
 * @param {AsyncIterable<any>} parts
 * @param {{ firstToken: () => void, snapshot: (call: { model?: import('./application.js').Model, usage?: import('./application.js').Usage }) => object }} metrics
 */
export async function* wireEvents(parts, metrics) {
    /** @type {import('./application.js').Model | undefined} */
    let model;
    /** @type {import('./application.js').Usage | undefined} */
    let usage;
    /** @type {import('./evidence.js').Evidence[]} */
    let evidence = [];
    let answered = false;
    let generating = false;
    for await (const part of parts) {
        switch (part.type) {
            case 'model':
                model = part.model;
                break;
            case 'tool-call':
                yield { progress: 'search' };
                break;
            case 'tool-result': {
                const found = /** @type {import('./evidence.js').Evidence[]} */ (part.output?.evidence ?? []);
                const urls = new Set(evidence.map((item) => item.url));
                const fresh = found.filter((item) => !urls.has(item.url));
                if (fresh.length) {
                    evidence = [...evidence, ...fresh];
                    yield { evidence };
                }
                break;
            }
            case 'text-delta':
                if (!part.text) break;
                if (!generating) {
                    generating = true;
                    yield { progress: 'generation' };
                }
                // Whitespace-only deltas are forwarded but do not count as an answer.
                if (!answered && part.text.trim()) {
                    answered = true;
                    metrics.firstToken();
                }
                yield { response: part.text };
                break;
            case 'finish': {
                const { inputTokens, outputTokens, totalTokens } = part.totalUsage ?? {};
                usage = { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens };
                break;
            }
            case 'tool-error':
                throw part.error instanceof Error ? part.error : new Error('Search failed', { cause: part.error });
            case 'abort':
                throw new Error('Chat stream aborted');
            case 'error':
                throw part.error instanceof Error ? part.error : new Error('AI stream failed', { cause: part.error });
        }
    }
    if (!answered) throw new Error('AI stream completed without an answer');
    if (usage) yield { usage };
    yield { metrics: metrics.snapshot({ model, usage }) };
}
