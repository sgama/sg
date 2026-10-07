import Cloudflare from 'cloudflare';
import { AI_CONFIG } from '../../functions/_lib/application.js';

export async function runEmbedding(client, accountId, model, text, options = {}) {
    // SDK 7's ai.run encodes model slashes, which the Workers AI route rejects.
    const response = await client.post(`/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`, {
        ...options, maxRetries: 0, body: { text },
    });
    return response?.result;
}

export function createCloudflareAi({
    accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken = process.env.CLOUDFLARE_API_TOKEN,
    namespace,
    timeoutMs = 60000,
    fetchImpl = fetch,
} = {}) {
    if (!accountId || !apiToken) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
    if (!namespace) throw new Error('A versioned corpus namespace is required');
    const client = new Cloudflare({ apiToken, fetch: fetchImpl, maxRetries: 0, timeout: timeoutMs });
    return {
        async retrieve(query) {
            const start = performance.now();
            const result = await runEmbedding(client, accountId, AI_CONFIG.embedding.model, [query]);
            const vector = result?.data?.[0];
            if (!Array.isArray(vector) || vector.length !== AI_CONFIG.embedding.dimensions
                || !vector.every(Number.isFinite)) throw new Error('Invalid embedding vector');
            const embedded = performance.now();
            const response = await client.vectorize.indexes.query(AI_CONFIG.retrieval.indexName, {
                account_id: accountId, vector, namespace,
                topK: AI_CONFIG.retrieval.topK, returnMetadata: 'all',
            });
            if (!Array.isArray(response.matches)) throw new Error('Invalid retrieval result');
            return { matches: response.matches, embeddingMs: embedded - start, searchMs: performance.now() - embedded };
        },
        async run(model, input) {
            const response = await fetchImpl(
                `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,
                {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(input),
                    signal: AbortSignal.timeout(timeoutMs),
                },
            );
            if (!response.ok || !response.body) {
                await response.body?.cancel();
                throw new Error(`Workers AI ${model} returned HTTP ${response.status}`);
            }
            if (!response.headers.get('content-type')?.includes('text/event-stream')) {
                await response.body.cancel();
                throw new Error(`Workers AI ${model} did not return SSE`);
            }
            return response.body;
        },
    };
}
