export function createAnswerParser(onDelta, onMetrics, { onProgress, onEvidence } = {}) {
    let buffer = '';
    let finished = false;
    const readLine = (line) => {
        if (finished || !line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data) return;
        if (data === '[DONE]') {
            finished = true;
            return;
        }
        const event = JSON.parse(data);
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid chat answer event');
        if (event.error) throw new Error(String(event.error));
        if (event.progress !== undefined) {
            if (!['rewrite', 'embedding', 'search', 'generation'].includes(event.progress)) throw new Error('Invalid chat progress event');
            onProgress?.(event.progress);
        }
        if (event.evidence !== undefined) {
            if (!Array.isArray(event.evidence)) throw new Error('Invalid chat evidence event');
            onEvidence?.(event.evidence);
        }
        if (event.metrics !== undefined) {
            if (!event.metrics || typeof event.metrics !== 'object' || Array.isArray(event.metrics)) throw new Error('Invalid chat metrics event');
            onMetrics?.(event.metrics);
        }
        if (event.response !== undefined) {
            if (typeof event.response !== 'string') throw new Error('Invalid chat answer event');
            onDelta(event.response);
        }
    };
    return {
        push(chunk) {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop();
            lines.forEach(readLine);
        },
        flush() {
            if (buffer) readLine(buffer);
            buffer = '';
        },
        get finished() {
            return finished;
        },
    };
}

export async function streamAnswer(query, { history = [], signal, onUpdate, onMetrics, onProgress, onEvidence, fetcher = fetch }) {
    const response = await fetcher('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, history }),
        signal,
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
