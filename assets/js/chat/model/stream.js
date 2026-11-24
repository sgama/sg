import { createParser } from 'eventsource-parser';

const PROGRESS_STAGES = new Set(['rewrite', 'embedding', 'search', 'generation']);
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @typedef {'rewrite' | 'embedding' | 'search' | 'generation'} Stage */

/** A failed chat request. `serverMessage` is the server's own client-safe explanation, when it sent one. */
export class ChatRequestError extends Error {
    /** @param {string} message @param {number} [status] @param {string | null} [serverMessage] */
    constructor(message, status, serverMessage = null) {
        super(message);
        this.status = status;
        this.serverMessage = serverMessage;
    }
}

/** @param {Response} response */
async function requestError(response) {
    const fallback = `Chat request failed (${response.status})`;
    // The body is opaque unless it is a JSON object with a non-empty string `error`.
    const payload = await response.json().catch(() => null);
    const serverMessage = isObject(payload) && typeof payload.error === 'string' ? payload.error.trim() : '';
    return new ChatRequestError(serverMessage || fallback, response.status, serverMessage || null);
}

/**
 * @param {(text: string) => void} onDelta
 * @param {((metrics: import('./metrics.js').ResponseMetrics) => void) | undefined} [onMetrics]
 * @param {{ onProgress?: (stage: Stage) => void, onEvidence?: (items: unknown[]) => void }} [handlers]
 *
 * Feeds raw SSE text and calls back for each validated event field. Framing (CRLF, split chunks, comments) is
 * eventsource-parser's job; this validates the widget's event shapes and fails loudly on anything else.
 */
export function createAnswerParser(onDelta, onMetrics, { onProgress, onEvidence } = {}) {
    let finished = false;
    /** @param {unknown} event */
    const handle = (event) => {
        if (!isObject(event)) throw new Error('Invalid chat answer event');
        if (event.error) throw new Error(String(event.error));
        if (event.progress !== undefined) {
            if (typeof event.progress !== 'string' || !PROGRESS_STAGES.has(event.progress)) throw new Error('Invalid chat progress event');
            onProgress?.(/** @type {Stage} */ (event.progress));
        }
        if (event.evidence !== undefined) {
            if (!Array.isArray(event.evidence)) throw new Error('Invalid chat evidence event');
            onEvidence?.(event.evidence);
        }
        if (event.metrics !== undefined) {
            if (!isObject(event.metrics)) throw new Error('Invalid chat metrics event');
            onMetrics?.(/** @type {import('./metrics.js').ResponseMetrics} */ (event.metrics));
        }
        if (event.response !== undefined) {
            if (typeof event.response !== 'string') throw new Error('Invalid chat answer event');
            onDelta(event.response);
        }
    };
    const parser = createParser({
        onEvent: ({ data }) => {
            if (finished || !data) return;
            if (data === '[DONE]') finished = true;
            else handle(JSON.parse(data));
        },
    });
    return {
        /** @param {string} chunk */
        push: (chunk) => parser.feed(chunk),
        // Delivers a final event the server did not terminate with a blank line.
        flush: () => parser.feed('\n\n'),
        get finished() {
            return finished;
        },
    };
}

// Total budget for one exchange, not an idle timer: a hung request fails here so the widget never stays busy forever.
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * @param {string} query
 * @param {{
 *     history?: import('./history.js').ApiMessage[],
 *     signal?: AbortSignal,
 *     onUpdate: (text: string) => void,
 *     onMetrics?: (metrics: import('./metrics.js').ResponseMetrics) => void,
 *     onProgress?: (stage: Stage) => void,
 *     onEvidence?: (items: unknown[]) => void,
 *     fetcher?: typeof fetch,
 *     timeoutMs?: number,
 * }} options
 * @returns {Promise<string>}
 */
export async function streamAnswer(
    query,
    { history = [], signal, onUpdate, onMetrics, onProgress, onEvidence, fetcher = fetch, timeoutMs = REQUEST_TIMEOUT_MS },
) {
    const response = await fetcher('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, history }),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw await requestError(response);
    if (!response.body) throw new Error('Chat response has no stream');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let answer = '';
    const parser = createAnswerParser(
        (delta) => {
            answer += delta;
            onUpdate(answer);
        },
        onMetrics,
        { onProgress, onEvidence },
    );
    let failure;
    let failed = false;
    try {
        while (!parser.finished) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.flush();
        if (!answer.trim()) throw new Error('Chat completed without an answer');
        if (!parser.finished) throw new Error('Chat stream ended before completion');
    } catch (error) {
        failed = true;
        failure = error;
    } finally {
        try {
            await reader.cancel();
        } catch (error) {
            if (failed) {
                console.warn('Chat stream cleanup failed after a request error.', error);
            } else {
                failed = true;
                failure = error;
            }
        } finally {
            reader.releaseLock();
        }
    }
    if (failed) throw failure;
    return answer;
}
