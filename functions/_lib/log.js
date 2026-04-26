import { CONFIG } from './config.js';

export class LogService {
    static async save(kv, query, responseStream, context = null, { now = () => new Date().toISOString() } = {}) {
        if (!kv) return responseStream;

        const decoder = new TextDecoder();
        let messageBuffer = "";
        let accumulatedResponse = "";
        let usageData = null;

        const loggingTransform = new TransformStream({
            transform(chunk, controller) {
                controller.enqueue(chunk);

                const decoded = decoder.decode(chunk, { stream: true });
                messageBuffer += decoded;

                const lines = messageBuffer.split('\n');
                messageBuffer = lines.pop() || "";

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.response) accumulatedResponse += parsed.response;
                            if (parsed.usage) usageData = parsed.usage;
                        } catch (e) { /* partial JSON */ }
                    }
                }
            },
            flush() {
                const timestamp = now();
                const key = `${CONFIG.KV_PREFIX}${timestamp}`;
                const payload = {
                    timestamp,
                    query,
                    response: accumulatedResponse,
                    usage: usageData
                };
                const savePromise = kv.put(key, "", {
                    expirationTtl: 2592000,
                    metadata: payload
                }).catch(e => console.error("Log Flush Error", e));

                if (context?.waitUntil) {
                    context.waitUntil(savePromise);
                } else {
                    return savePromise;
                }
            }
        });

        return responseStream.pipeThrough(loggingTransform);
    }

    static async fetchLogs(kv, limit, cursor) {
        const listResult = await kv.list({
            prefix: CONFIG.KV_PREFIX,
            limit,
            ...(cursor && { cursor })
        });

        const logs = listResult.keys
            .reverse()
            .map((key) => key.metadata ? { id: key.name, ...key.metadata } : null)
            .filter(Boolean);

        return {
            data: logs.filter(Boolean),
            meta: {
                count: logs.length,
                limit,
                cursor: listResult.cursor,
                has_more: !listResult.list_complete
            }
        };
    }
}
