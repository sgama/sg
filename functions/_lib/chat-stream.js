export function createSseMessageStream(message) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: message })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
    });
}

export function normalizeChatStream(stream) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let dataLines = [];
    let hasAnswer = false;
    let hasContentDeltas = false;
    let finished = false;

    const emit = (controller, payload) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    };
    const complete = (controller) => {
        if (!hasAnswer) throw new Error('AI stream completed without an answer');
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
        const choice = payload.choices?.find((item) => item.index === 0);
        const content = choice?.delta?.content;
        if (typeof content === 'string' && content) {
            hasContentDeltas = true;
            hasAnswer ||= content.trim().length > 0;
            emit(controller, { response: content });
        } else if (!hasContentDeltas && typeof payload.response === 'string' && payload.response) {
            hasAnswer ||= payload.response.trim().length > 0;
            emit(controller, { response: payload.response });
        }
        // Workers AI's final legacy event contains aggregate usage; chunk usage is incremental.
        if (
            payload.usage &&
            (typeof payload.response === 'string' || !payload.choices || (payload.choices.length === 0 && payload.usage.total_tokens > 0))
        ) {
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
