import { EventSourceParserStream } from 'eventsource-parser/stream';

const ENCODER = new TextEncoder();

export const DONE_PAYLOAD = '[DONE]';
const DONE_FRAME = ENCODER.encode(`data: ${DONE_PAYLOAD}\n\n`);
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
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{ onUsage?: (usage: object) => void, onFirstToken?: () => void, metrics?: () => object }} [options]
 */
export function normalizeChatStream(stream, { onUsage, onFirstToken, metrics } = {}) {
    let hasAnswer = false;
    let finished = false;
    let errorSent = false;
    let emitted = false;

    const send = (controller, payload) => {
        emitted = true;
        controller.enqueue(frame(payload));
    };
    const end = (controller) => {
        emitted = true;
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
        if (!reader) return;
        try {
            await reader.cancel(error);
        } catch (cancelError) {
            console.error('Chat Stream Cancel Failed:', cancelError);
        }
    };

    const reader = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();

    return new ReadableStream({
        async pull(controller) {
            emitted = false;
            while (!emitted) {
                if (finished) {
                    controller.close();
                    return;
                }
                let result;
                try {
                    result = await reader.read();
                } catch (error) {
                    await fail(controller, error);
                    continue;
                }
                if (result.done) {
                    try {
                        complete(controller);
                    } catch (error) {
                        await fail(controller, error, reader);
                    }
                    continue;
                }
                try {
                    handle(result.value.data, controller);
                } catch (error) {
                    await fail(controller, error, reader);
                }
            }
        },
        cancel(reason) {
            finished = true;
            return reader.cancel(reason);
        },
    });
}
