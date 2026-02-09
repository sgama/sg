import { CONFIG } from './config.js';

/**
 * Service to handle interaction with Cloudflare Workers AI
 */
export class AiService {
    constructor(env) {
        this.ai = env.AI;
        this.vectorize = env.VECTORIZE_INDEX;
    }

    /**
     * Generate embeddings for a query
     */
    async getEmbeddings(text) {
        try {
            const { data } = await this.ai.run(CONFIG.MODELS.EMBEDDINGS, { text: [text] });
            return data[0];
        } catch (err) {
            console.error('Embedding Generation Failed:', err);
            return null; // Fail safe
        }
    }

    /**
     * Search vector database
     */
    async retrieveContext(query) {
        if (!this.vectorize) return "";

        const vector = await this.getEmbeddings(query);
        if (!vector) return "";

        try {
            const results = await this.vectorize.query(vector, {
                topK: CONFIG.VECTOR_SEARCH.TOP_K,
                returnMetadata: true
            });

            if (!results.matches) return "";

            return results.matches
                .map(m => m.metadata?.text || "")
                .filter(text => text.length > 0)
                .join("\n---\n");
        } catch (err) {
            console.error('Vector Search Failed:', err);
            return ""; // Graceful degradation
        }
    }

    /**
     * Stream response from LLM
     */
    async generateStream(query, contextText) {
        const messages = [
            {
                role: "system",
                content: `${CONFIG.SYSTEM_PROMPT}\n\nContext:\n${contextText}`
            },
            { role: "user", content: query }
        ];

        return await this.ai.run(CONFIG.MODELS.GENERATION, {
            messages,
            stream: true
        });
    }
}

/**
 * Service to handle logging
 */
export class LogService {
    static async save(kv, query, responseStream, context = null) {
        if (!kv) return responseStream;

        const decoder = new TextDecoder();
        let messageBuffer = "";
        let accumulatedResponse = "";
        let usageData = null;

        const loggingTransform = new TransformStream({
            transform(chunk, controller) {
                // Pass raw chunk through to client immediately
                controller.enqueue(chunk);

                // Decode and buffer for processing
                const decoded = decoder.decode(chunk, { stream: true });
                messageBuffer += decoded;

                // Process complete SSE lines
                const lines = messageBuffer.split('\n');

                // Keep the last incomplete line in the buffer
                messageBuffer = lines.pop() || "";

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.response) {
                                accumulatedResponse += parsed.response;
                            }
                            if (parsed.usage) {
                                usageData = parsed.usage;
                            }
                        } catch (e) {
                            // Ignore parse errors for partial json
                        }
                    }
                }
            },
            flush() {
                // Background save
                const timestamp = new Date().toISOString();
                const key = `${CONFIG.KV_PREFIX}${timestamp}`;

                const savePromise = kv.put(key, JSON.stringify({
                    timestamp,
                    query,
                    response: accumulatedResponse,
                    usage: usageData
                }), { expirationTtl: 2592000 }).catch(e => console.error("Log Flush Error", e));

                // If context is provided, use waitUntil to avoid blocking response
                if (context && context.waitUntil) {
                    context.waitUntil(savePromise);
                } else {
                    return savePromise;
                }
            }
        });

        return responseStream.pipeThrough(loggingTransform);
    }

    /**
     * Fetches formatted logs from KV
     * @param {KVNamespace} kv
     * @param {number} limit
     * @param {string|null} cursor
     */
    static async fetchLogs(kv, limit, cursor) {
        // A. List Keys (Pagination handled by KV)
        const listOptions = {
            prefix: CONFIG.KV_PREFIX,
            limit: limit,
            ...(cursor && { cursor })
        };

        const listResult = await kv.list(listOptions);

        // B. Data Hydration (N+1 Fetch pattern)
        const logs = await Promise.all(
            listResult.keys.reverse().map(async (key) => {
                const value = await kv.get(key.name, { type: "json" });

                // Filter out malformed data or legacy non-object values
                if (!value || typeof value !== 'object') {
                    return null;
                }

                return {
                    id: key.name,
                    ...value
                };
            })
        );

        return {
            data: logs.filter(log => log !== null),
            meta: {
                count: logs.length,
                cursor: listResult.cursor,
                has_more: !listResult.list_complete
            }
        };
    }
}
