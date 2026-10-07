import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pLimit from 'p-limit';
import Cloudflare, { toFile } from 'cloudflare';
import { AI_CONFIG } from '../functions/_lib/config.js';
import { buildCorpus, validateCorpus } from './lib/corpus.mjs';

export { buildCorpus } from './lib/corpus.mjs';

export async function ingestCorpus(client, accountId, corpus, {
    namespace,
    indexName = AI_CONFIG.retrieval.indexName,
    concurrency = 5,
    batchSize = 1000,
    afterMutation,
} = {}) {
    validateCorpus(corpus);
    if (!namespace || namespace !== corpus.namespace) {
        throw new Error(`Explicit --namespace must match computed namespace: ${corpus.namespace}`);
    }
    if (!accountId || !indexName) throw new Error('Account ID and index name are required');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5
        || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
        throw new Error('Concurrency must be 1–5 and batch size must be 1–1000');
    }
    if (!corpus.chunks.length) throw new Error('Refusing to ingest an empty corpus');
    const limit = pLimit(concurrency);
    const vectors = await Promise.all(corpus.chunks.map((chunk) => limit(async () => {
        const result = await client.ai.run(corpus.embedding.model, {
            account_id: accountId,
            text: [chunk.text],
        });
        const values = result?.data?.[0];
        if (!Array.isArray(result?.data) || result.data.length !== 1
            || !Array.isArray(values) || values.length !== corpus.embedding.dimensions
            || !values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
            throw new Error(`Invalid embedding dimensions or values for ${chunk.id}`);
        }
        return { id: chunk.id, values, namespace, metadata: chunk.metadata };
    })));

    const mutationIds = [];
    for (let i = 0; i < vectors.length; i += batchSize) {
        const batch = vectors.slice(i, i + batchSize);
        const body = await toFile(batch.map((vector) => JSON.stringify(vector)).join('\n') + '\n',
            'vectors.ndjson', { type: 'application/x-ndjson' });
        const result = await client.vectorize.indexes.upsert(indexName, {
            account_id: accountId,
            body,
            'unparsable-behavior': 'error',
        });
        if (typeof result?.mutationId !== 'string' || !result.mutationId.trim()) {
            throw new Error(`Upsert batch ${mutationIds.length + 1} was not accepted: missing mutationId`);
        }
        mutationIds.push(result.mutationId);
        if (afterMutation) await afterMutation(result.mutationId);
    }
    // Mutation IDs acknowledge asynchronous acceptance, not query readiness or activation.
    return { namespace, count: vectors.length, mutationIds };
}

export async function main(args = process.argv.slice(2)) {
    const { values } = parseArgs({
        args,
        options: {
            check: { type: 'boolean', default: false },
            manifest: { type: 'string' },
            namespace: { type: 'string' },
        },
    });
    const corpus = await buildCorpus();
    if (values.manifest) {
        await mkdir(path.dirname(values.manifest), { recursive: true });
        const manifest = {
            ...corpus,
            chunks: corpus.chunks.map(({ id, chunkIndex, metadata }) => {
                const { text, ...sourceMetadata } = metadata;
                return { id, chunkIndex, metadata: sourceMetadata };
            }),
        };
        await writeFile(values.manifest, JSON.stringify(manifest, null, 2) + '\n');
    }
    console.log(JSON.stringify({
        namespace: corpus.namespace, hash: corpus.hash, counts: corpus.counts,
        embedding: corpus.embedding, chunking: corpus.chunking,
    }, null, 2));
    if (values.check) return corpus;
    if (values.namespace !== corpus.namespace) {
        throw new Error(`Explicit --namespace must match computed namespace: ${corpus.namespace}`);
    }
    await import('dotenv/config');
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = process.env;
    if (!accountId || !apiToken) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
    const result = await ingestCorpus(new Cloudflare({ apiToken }), accountId, corpus, {
        namespace: values.namespace,
    });
    console.log(JSON.stringify({ ...result, status: 'accepted (asynchronous; not activated)' }, null, 2));
    return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`Embedding pipeline failed: ${error.message}`);
        process.exitCode = 1;
    });
}
