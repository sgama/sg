export function createSseMessageStream(message, metrics) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: message })}\n\n`));
            if (metrics) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ metrics })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
    });
}

export function normalizeChatStream(stream, { onUsage, onFirstToken, metrics } = {}) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let dataLines = [];
    let hasAnswer = false;
    let finished = false;

    const emit = (controller, payload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    };
    const complete = (controller) => {
        if (!hasAnswer) throw new Error('AI stream completed without an answer');
        if (metrics) emit(controller, { metrics: metrics() });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        finished = true;
    };
    const dispatch = (controller) => {
        if (!dataLines.length || finished) return;
        const data = dataLines.join('\n');
        dataLines = [];
        if (data.trim() === '[DONE]') {
            complete(controller);
            return;
        }
        const payload = JSON.parse(data);
        if (payload.error) throw new Error('AI returned a streaming error');
        const bindingUsageSummary = hasAnswer && payload.response === '' && payload.usage && payload.choices === undefined;
        if (!Array.isArray(payload.choices) && !bindingUsageSummary) throw new Error('Unsupported AI stream event: expected choices');
        const choice = payload.choices?.find((item) => item.index === 0);
        const content = choice?.delta?.content;
        if (typeof content === 'string' && content) {
            if (!hasAnswer && content.trim()) onFirstToken?.();
            hasAnswer ||= content.trim().length > 0;
            emit(controller, { response: content });
        }
        if (payload.usage && (bindingUsageSummary || (payload.choices.length === 0 && payload.usage.total_tokens > 0))) {
            onUsage?.(payload.usage);
            emit(controller, { usage: payload.usage });
        }
    };
    const handleLine = (line, controller) => {
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) {
            dispatch(controller);
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
        }
    };
    const consume = (text, controller, flush = false) => {
        if (finished) return;
        try {
            buffer += text;
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) handleLine(line, controller);
            if (flush && !finished) {
                if (buffer) handleLine(buffer, controller);
                dispatch(controller);
                if (!finished) complete(controller);
            }
        } catch (err) {
            console.error('Chat Stream Failed:', err);
            emit(controller, { error: 'AI response failed. Please try again.' });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            finished = true;
        }
    };

    return stream.pipeThrough(
        new TransformStream({
            transform(chunk, controller) {
                consume(decoder.decode(chunk, { stream: true }), controller);
            },
            flush(controller) {
                consume(decoder.decode(), controller, true);
            },
        }),
    );
}
