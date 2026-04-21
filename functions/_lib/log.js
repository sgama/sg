import { CONFIG } from './config.js';

export class LogService {
    static async save(kv, query, responseStream, context = null) {
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
                const timestamp = new Date().toISOString();
                const key = `${CONFIG.KV_PREFIX}${timestamp}`;
                const savePromise = kv.put(key, JSON.stringify({
                    timestamp,
                    query,
                    response: accumulatedResponse,
                    usage: usageData
                }), { expirationTtl: 2592000 }).catch(e => console.error("Log Flush Error", e));

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

        const logs = await Promise.all(
            listResult.keys.reverse().map(async (key) => {
                const value = await kv.get(key.name, { type: "json" });
                if (!value || typeof value !== 'object') return null;
                return { id: key.name, ...value };
            })
        );

        return {
            data: logs.filter(Boolean),
            meta: {
                count: logs.length,
                cursor: listResult.cursor,
                has_more: !listResult.list_complete
            }
        };
    }
}
