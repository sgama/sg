export function createAnswerParser(onDelta) {
    let buffer = "";
    let finished = false;
    const readLine = (line) => {
        if (finished || !line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data) return;
        if (data === "[DONE]") {
            finished = true;
            return;
        }
        const event = JSON.parse(data);
        if (event.error) throw new Error(String(event.error));
        if (event.response !== undefined) {
            if (typeof event.response !== "string") throw new Error("Invalid chat answer event");
            onDelta(event.response);
        }
    };
    return {
        push(chunk) {
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop();
            lines.forEach(readLine);
        },
        flush() {
            if (buffer) readLine(buffer);
            buffer = "";
        },
        get finished() { return finished; },
    };
}

export async function streamAnswer(query, { signal, onUpdate, fetcher = fetch }) {
    const response = await fetcher("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal,
    });
    if (!response.ok) throw new Error(`Chat request failed (${response.status})`);
    if (!response.body) throw new Error("Chat response has no stream");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let answer = "";
    const parser = createAnswerParser((delta) => {
        answer += delta;
        onUpdate(answer);
    });
    try {
        while (!parser.finished) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.flush();
        if (!answer.trim()) throw new Error("Chat completed without an answer");
        if (!parser.finished) throw new Error("Chat stream ended before completion");
        return answer;
    } finally {
        try {
            await reader.cancel();
        } finally {
            reader.releaseLock();
        }
    }
}
