import { CONFIG } from './application.js';

export class LogService {
    static async save(env, query, responseStream, context = null, { now = () => new Date().toISOString(), id = () => crypto.randomUUID() } = {}) {
        const kv = env?.CHAT_LOGS;
        if (!kv) return responseStream;

        const decoder = new TextDecoder();
        let messageBuffer = '';
        let accumulatedResponse = '';
        let usageData = null;
        let streamError = null;
        let persisted = false;

        const persist = () => {
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
        };

        const observe = (value) => {
            const decoded = decoder.decode(value, { stream: true });
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
                        if (parsed.error) {
                            streamError = parsed.error;
                            // Persist on error so an aborted stream still records the partial answer.
                            if (!persisted) {
                                persisted = true;
                                persist();
                            }
                        }
                    } catch (_error) {
                        /* partial JSON */
                    }
                }
            }
        };

        // Persist once: on normal end, on an error event, or when the client disconnects. A
        // TransformStream would miss the disconnect case, so the stream is built by hand.
        const finalise = () => {
            if (persisted) return;
            persisted = true;
            return persist();
        };
        const reader = responseStream.getReader();
        return new ReadableStream({
            async pull(controller) {
                let result;
                try {
                    result = await reader.read();
                } catch (error) {
                    finalise();
                    controller.error(error);
                    return;
                }
                if (result.done) {
                    finalise();
                    controller.close();
                    return;
                }
                observe(result.value);
                controller.enqueue(result.value);
            },
            cancel(reason) {
                finalise();
                return reader.cancel(reason);
            },
        });
    }

    static async fetchLogs(env, limit, cursor) {
        const kv = env?.CHAT_LOGS;
        if (!kv) throw new Error('KV binding missing');

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
                    // Legacy/foreign records (missing metadata or version !== 2) must never 500 the whole page.
                    if (key.metadata?.version !== 2) {
                        console.error('Unsupported log record version:', key.name);
                        return null;
                    }
                    let record;
                    try {
                        record = await kv.get(key.name, 'json');
                    } catch (err) {
                        console.error('Log record read failed:', key.name, err);
                        return null;
                    }
                    if (!record) {
                        console.error('Log record missing:', key.name);
                        return null;
                    }
                    return { ...record, id: key.name };
                }),
        );

        const data = logs.filter(Boolean);
        return {
            data,
            meta: {
                count: data.length,
                limit,
                cursor: listResult.cursor,
                has_more: !listResult.list_complete,
            },
        };
    }
}
