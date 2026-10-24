import { createParser } from 'eventsource-parser';

const PROGRESS_STAGES = new Set(['rewrite', 'embedding', 'search', 'generation']);
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

/**
 * Feeds raw SSE text and calls back for each validated event field. Framing (CRLF, split chunks, comments) is
 * eventsource-parser's job; this validates the widget's event shapes and fails loudly on anything else.
 */
export function createAnswerParser(onDelta, onMetrics, { onProgress, onEvidence } = {}) {
    let finished = false;
    const handle = (event) => {
        if (!isObject(event)) throw new Error('Invalid chat answer event');
        if (event.error) throw new Error(String(event.error));
        if (event.progress !== undefined) {
            if (!PROGRESS_STAGES.has(event.progress)) throw new Error('Invalid chat progress event');
            onProgress?.(event.progress);
        }
        if (event.evidence !== undefined) {
            if (!Array.isArray(event.evidence)) throw new Error('Invalid chat evidence event');
            onEvidence?.(event.evidence);
        }
        if (event.metrics !== undefined) {
            if (!isObject(event.metrics)) throw new Error('Invalid chat metrics event');
            onMetrics?.(event.metrics);
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
        push: (chunk) => parser.feed(chunk),
        // Delivers a final event the server did not terminate with a blank line.
        flush: () => parser.feed('\n\n'),
        get finished() {
            return finished;
        },
    };
}

// A stalled stream fails instead of leaving the widget busy forever; the user can still cancel earlier.
const REQUEST_TIMEOUT_MS = 120_000;

export async function streamAnswer(
    query,
    { history = [], signal, onUpdate, onMetrics, onProgress, onEvidence, fetcher = fetch, timeoutMs = REQUEST_TIMEOUT_MS },
) {
    const response = await fetcher('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, history }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Chat request failed (${response.status})`);
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
