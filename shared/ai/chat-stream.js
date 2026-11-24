import { EventSourceParserStream } from 'eventsource-parser/stream';
import { isDeadlineAbort } from './abort.js';

const ENCODER = new TextEncoder();

/** Terminal payload; the framing around it is production detail, the token itself is the wire contract. */
export const DONE_PAYLOAD = '[DONE]';
const DONE_FRAME = ENCODER.encode(`data: ${DONE_PAYLOAD}\n\n`);

/** One SSE frame. The widget's wire format is produced here only. */
const frame = (payload) => ENCODER.encode(`data: ${JSON.stringify(payload)}\n\n`);

export function createSseMessageStream(message, metrics) {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(frame({ response: message }));
            if (metrics) controller.enqueue(frame({ metrics }));
            controller.enqueue(DONE_FRAME);
            controller.close();
        },
    });
}

const FAILURE_MESSAGE = 'AI response failed. Please try again.';

/**
 * Turns the provider's SSE stream into the widget's: `{ response }`, `{ usage }`, a final `{ metrics }` and `[DONE]`.
 * Framing (CRLF, comments, multi-line data, split UTF-8) is left to eventsource-parser; any failure becomes one
 * `{ error }` event followed by `[DONE]`, so the widget always gets a terminated stream. A client abort ends the
 * stream silently; the request deadline ends it like a failure. Ending early cancels the provider stream.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{ onUsage?: (usage: object) => void, onFirstToken?: () => void, metrics?: () => object, signal?: AbortSignal, deadlineSignal?: AbortSignal }} [options]
 */
export function normalizeChatStream(stream, { onUsage, onFirstToken, metrics, signal, deadlineSignal } = {}) {
    let hasAnswer = false;
    let finished = false;
    /** @type {TransformStreamDefaultController<Uint8Array>} */
    let out;

    const send = (payload) => out.enqueue(frame(payload));
    // The one way out: `error` adds the failure event, then [DONE]; `terminate` also cancels the provider stream.
    const finish = ({ error = false, silent = false } = {}) => {
        if (finished) return;
        finished = true;
        if (!silent) {
            if (error) send({ error: FAILURE_MESSAGE });
            out.enqueue(DONE_FRAME);
        }
        out.terminate();
    };
    const fail = (error) => {
        if (finished) return;
        console.error('Chat Stream Failed:', error);
        finish({ error: true });
    };
    const complete = () => {
        if (!hasAnswer) throw new Error('AI stream completed without an answer');
        if (metrics) send({ metrics: metrics() });
        finish();
    };
    const handle = (data) => {
        if (data.trim() === '[DONE]') return complete();
        const payload = JSON.parse(data);
        if (payload.error) throw new Error('AI returned a streaming error');
        const bindingUsageSummary = hasAnswer && payload.response === '' && payload.usage && payload.choices === undefined;
        if (!Array.isArray(payload.choices) && !bindingUsageSummary) throw new Error('Unsupported AI stream event: expected choices');
        const content = payload.choices?.find((item) => item.index === 0)?.delta?.content;
        if (typeof content === 'string' && content) {
            // Whitespace-only chunks are forwarded but do not count as an answer.
            if (!hasAnswer && content.trim()) onFirstToken?.();
            hasAnswer ||= content.trim().length > 0;
            send({ response: content });
        }
        if (payload.usage && (bindingUsageSummary || (payload.choices.length === 0 && payload.usage.total_tokens > 0))) {
            onUsage?.(payload.usage);
            send({ usage: payload.usage });
        }
    };
    const attempt = (step) => {
        try {
            step();
        } catch (error) {
            fail(error);
        }
    };

    const normalizer = new TransformStream({
        start(controller) {
            out = controller;
        },
        transform: (event) => {
            if (!finished) attempt(() => handle(event.data));
        },
        flush: () => {
            if (!finished) attempt(complete);
        },
    });
    // preventAbort: an upstream error must reach `fail` so the client still gets an error event and [DONE].
    stream
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream())
        .pipeTo(normalizer.writable, { preventAbort: true })
        .catch(fail);

    const onAbort = () => finish(isDeadlineAbort(signal, deadlineSignal) ? { error: true } : { silent: true });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    return normalizer.readable;
}
