import Cloudflare from 'cloudflare';
import { AI_CONFIG, contextualizationInput, contextualizedQueryFromResponse, getModel } from '../../functions/_lib/application.js';
import { retrieveEvidence } from '../../functions/_lib/retrieval-pipeline.js';

/** One error message for every CLI that needs Cloudflare credentials. */
export function requireCloudflareCredentials(env = process.env) {
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = env;
    if (!accountId || !apiToken) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
    return { accountId, apiToken };
}

export async function runEmbedding(client, accountId, model, text, options = {}) {
    // SDK 7's ai.run encodes model slashes, which the Workers AI route rejects.
    const response = await client.post(`/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`, {
        ...options,
        maxRetries: 0,
        body: { text },
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
    const client = new Cloudflare({
        apiToken,
        fetch: fetchImpl,
        maxRetries: 0,
        timeout: timeoutMs,
    });
    const contextualizationModel = getModel(AI_CONFIG.contextualization.model);
    // One place for direct Workers AI REST calls: auth, timeout and HTTP status handling.
    const post = (modelId, input) =>
        fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${modelId}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(timeoutMs),
        });
    const runJson = async (modelId, input) => {
        const response = await post(modelId, input);
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Workers AI ${modelId} returned HTTP ${response.status}`);
        }
        const payload = await response.json();
        if (payload?.success === false) throw new Error(`Workers AI ${modelId} returned an unsuccessful response`);
        return payload?.result;
    };
    return {
        /** Same pipeline as production (retrieval-pipeline.js); only the transports differ. */
        async retrieve(query, history = []) {
            const retrievalQuery = history.length
                ? contextualizedQueryFromResponse(
                      await runJson(contextualizationModel.id, contextualizationInput(contextualizationModel, query, history)),
                  )
                : query;
            const timing = { embeddingMs: 0, searchMs: 0 };
            const timed = async (key, work) => {
                const started = performance.now();
                try {
                    return await work();
                } finally {
                    timing[key] += performance.now() - started;
                }
            };
            const { matches } = await retrieveEvidence({
                retrievalQuery,
                namespace,
                embed: (text) =>
                    timed('embeddingMs', async () => {
                        const vector = (await runEmbedding(client, accountId, AI_CONFIG.embedding.model, [text]))?.data?.[0];
                        if (!Array.isArray(vector) || vector.length !== AI_CONFIG.embedding.dimensions || !vector.every(Number.isFinite))
                            throw new Error('Invalid embedding vector');
                        return vector;
                    }),
                search: (vector) =>
                    timed(
                        'searchMs',
                        async () =>
                            (
                                await client.vectorize.indexes.query(AI_CONFIG.retrieval.indexName, {
                                    account_id: accountId,
                                    vector,
                                    namespace,
                                    topK: AI_CONFIG.retrieval.topK,
                                    returnMetadata: 'all',
                                })
                            ).matches,
                    ),
                fetchSections: (ids) =>
                    timed('searchMs', () => client.vectorize.indexes.getByIDs(AI_CONFIG.retrieval.indexName, { account_id: accountId, ids })),
            });
            return { matches, retrievalQuery, ...timing };
        },
        async run(modelId, input) {
            const response = await post(modelId, input);
            if (!response.ok || !response.body) {
                await response.body?.cancel();
                throw new Error(`Workers AI ${modelId} returned HTTP ${response.status}`);
            }
            if (!response.headers.get('content-type')?.includes('text/event-stream')) {
                await response.body.cancel();
                throw new Error(`Workers AI ${modelId} did not return SSE`);
            }
            return response.body;
        },
    };
}
