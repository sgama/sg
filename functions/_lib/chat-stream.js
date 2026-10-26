import { EventSourceParserStream } from 'eventsource-parser/stream';

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

/**
 * Turns the provider's SSE stream into the widget's: `{ response }`, `{ usage }`, a final `{ metrics }` and `[DONE]`.
 * Framing (CRLF, comments, multi-line data, split UTF-8) is left to eventsource-parser; any failure becomes one
 * `{ error }` event followed by `[DONE]`, so the widget always gets a terminated stream.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{ onUsage?: (usage: object) => void, onFirstToken?: () => void, metrics?: () => object }} [options]
 */
export function normalizeChatStream(stream, { onUsage, onFirstToken, metrics } = {}) {
    let hasAnswer = false;
    let finished = false;
    let errorSent = false;

    const send = (controller, payload) => controller.enqueue(frame(payload));
    const end = (controller) => {
        controller.enqueue(DONE_FRAME);
        finished = true;
    };
    const complete = (controller) => {
        if (!hasAnswer) throw new Error('AI stream completed without an answer');
        if (metrics) send(controller, { metrics: metrics() });
        end(controller);
    };
    const handle = (data, controller) => {
        if (data.trim() === '[DONE]') return complete(controller);
        const payload = JSON.parse(data);
        if (payload.error) throw new Error('AI returned a streaming error');
        const bindingUsageSummary = hasAnswer && payload.response === '' && payload.usage && payload.choices === undefined;
        if (!Array.isArray(payload.choices) && !bindingUsageSummary) throw new Error('Unsupported AI stream event: expected choices');
        const content = payload.choices?.find((item) => item.index === 0)?.delta?.content;
        if (typeof content === 'string' && content) {
            // Whitespace-only chunks are forwarded but do not count as an answer.
            if (!hasAnswer && content.trim()) onFirstToken?.();
            hasAnswer ||= content.trim().length > 0;
            send(controller, { response: content });
        }
        if (payload.usage && (bindingUsageSummary || (payload.choices.length === 0 && payload.usage.total_tokens > 0))) {
            onUsage?.(payload.usage);
            send(controller, { usage: payload.usage });
        }
    };
    const fail = async (controller, error, reader) => {
        if (finished) return;
        finished = true;
        console.error('Chat Stream Failed:', error);
        if (!errorSent) {
            send(controller, { error: 'AI response failed. Please try again.' });
            errorSent = true;
        }
        end(controller);
        try {
            await reader.cancel(error);
        } catch (cancelError) {
            console.error('Chat Stream Cancel Failed:', cancelError);
        }
    };

    const reader = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();

    return new ReadableStream({
        async pull(controller) {
            if (finished) {
                controller.close();
                return;
            }
            try {
                const { done, value } = await reader.read();
                if (done) {
                    try {
                        complete(controller);
                    } catch (error) {
                        await fail(controller, error, reader);
                    }
                    controller.close();
                    return;
                }
                try {
                    handle(value.data, controller);
                } catch (error) {
                    await fail(controller, error, reader);
                    controller.close();
                    return;
                }
            } catch (error) {
                await fail(controller, error, reader);
                controller.close();
            }
        },
        cancel(reason) {
            finished = true;
            return reader.cancel(reason);
        },
    });
}
