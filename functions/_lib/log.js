import { CONFIG } from './application.js';

export class LogService {
    static async save(kv, query, responseStream, context = null, { now = () => new Date().toISOString(), id = () => crypto.randomUUID() } = {}) {
        if (!kv) return responseStream;

        const decoder = new TextDecoder();
        let messageBuffer = '';
        let accumulatedResponse = '';
        let usageData = null;
        let streamError = null;

        const loggingTransform = new TransformStream({
            transform(chunk, controller) {
                controller.enqueue(chunk);

                const decoded = decoder.decode(chunk, { stream: true });
                messageBuffer += decoded;

                const lines = messageBuffer.split('\n');
                messageBuffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.response) accumulatedResponse += parsed.response;
                            if (parsed.usage) usageData = parsed.usage;
                            if (parsed.error) streamError = parsed.error;
                        } catch (_error) {
                            /* partial JSON */
                        }
                    }
                }
            },
            flush() {
                const timestamp = now();
                const key = `${CONFIG.KV_PREFIX}${timestamp}:${id()}`;
                const payload = {
                    timestamp,
                    query,
                    response: accumulatedResponse,
                    usage: usageData,
                    ...(streamError ? { error: streamError } : {}),
                };
                const savePromise = kv
                    .put(key, JSON.stringify(payload), {
                        expirationTtl: 2592000,
                        metadata: { timestamp, version: 2 },
                    })
                    .catch((e) => console.error('Log Flush Error', e));

                if (context?.waitUntil) {
                    context.waitUntil(savePromise);
                } else {
                    return savePromise;
                }
            },
        });

        return responseStream.pipeThrough(loggingTransform);
    }

    static async fetchLogs(kv, limit, cursor) {
        const listResult = await kv.list({
            prefix: CONFIG.KV_PREFIX,
            limit,
            ...(cursor && { cursor }),
        });

        const logs = await Promise.all(
            listResult.keys
                .slice()
                .reverse()
                .map(async (key) => {
                    if (key.metadata?.version !== 2) throw new Error(`Unsupported log record version: ${key.name}`);
                    const record = await kv.get(key.name, 'json');
                    if (!record) {
                        console.error('Log record missing:', key.name);
                        return null;
                    }
                    return { ...record, id: key.name };
                }),
        );

        return {
            data: logs.filter(Boolean),
            meta: {
                count: logs.filter(Boolean).length,
                limit,
                cursor: listResult.cursor,
                has_more: !listResult.list_complete,
            },
        };
    }
}
