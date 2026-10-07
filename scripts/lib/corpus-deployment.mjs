import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pLimit from 'p-limit';
import Cloudflare, { toFile } from 'cloudflare';
import { AI_CONFIG } from '../../functions/_lib/application.js';
import { buildCorpus, validateCorpus } from './corpus.mjs';
import { runEmbedding } from './cloudflare-ai.mjs';

export function createMaintenanceClient(apiToken, fetch = globalThis.fetch) {
    return new Cloudflare({ apiToken, fetch, maxRetries: 2, timeout: 30000 });
}

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
    const controller = new AbortController();
    const vectors = await Promise.all(corpus.chunks.map((chunk) => limit(async () => {
        controller.signal.throwIfAborted();
        try {
            const result = await runEmbedding(client, accountId, corpus.embedding.model,
                [chunk.text], { signal: controller.signal });
            controller.signal.throwIfAborted();
            const values = result?.data?.[0];
            if (!Array.isArray(result?.data) || result.data.length !== 1
                || !Array.isArray(values) || values.length !== corpus.embedding.dimensions
                || !values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
                throw new Error(`Invalid embedding dimensions or values for ${chunk.id}`);
            }
            return { id: chunk.id, values, namespace, metadata: chunk.metadata };
        } catch (error) {
            controller.abort(error);
            throw controller.signal.reason;
        }
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

export function setCorpusNamespace(config, namespace) {
    if (!/^corpus-[a-f0-9]{56}$/.test(namespace)) throw new Error('Invalid corpus namespace');
    const sections = config.split(/(^\[[^\r\n]+\][ \t]*\r?$)/m);
    const index = sections.findIndex(section => section === '[vars]');
    if (index === -1 || index + 1 >= sections.length) throw new Error('Wrangler [vars] section is required');
    const entries = sections[index + 1].match(/^AI_CORPUS_NAMESPACE\s*=.*$/gm) ?? [];
    if (entries.length > 1) throw new Error('Duplicate AI_CORPUS_NAMESPACE settings');
    const setting = `AI_CORPUS_NAMESPACE = "${namespace}"`;
    sections[index + 1] = entries.length
        ? sections[index + 1].replace(/^AI_CORPUS_NAMESPACE\s*=.*$/m, setting)
        : `\n${setting}${sections[index + 1]}`;
    return sections.join('');
}

export async function waitForMutation(client, accountId, mutationId, {
    indexName = AI_CONFIG.retrieval.indexName,
    timeoutMs = 180000,
    intervalMs = 2000,
    clock = () => performance.now(),
    sleep = (ms, signal) => delay(ms, undefined, { signal }),
} = {}) {
    const signal = AbortSignal.timeout(timeoutMs);
    const start = clock();
    const timeoutError = () => new Error(`Timed out waiting for Vectorize mutation ${mutationId}; corpus was not activated`);
    let onAbort;
    const deadline = new Promise((_, reject) => {
        onAbort = () => reject(timeoutError());
        signal.addEventListener('abort', onAbort, { once: true });
    });
    const poll = async () => {
        while (clock() - start < timeoutMs) {
            signal.throwIfAborted();
            const info = await client.vectorize.indexes.info(indexName,
                { account_id: accountId }, { signal });
            signal.throwIfAborted();
            if (info?.dimensions !== AI_CONFIG.embedding.dimensions) throw new Error('Vectorize index dimensions do not match embedding configuration');
            if (info.processedUpToMutation === mutationId) return;
            await sleep(intervalMs, signal);
        }
        throw timeoutError();
    };
    try {
        // SDK retry backoff may not observe cancellation until its next request.
        await Promise.race([deadline, poll()]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

export async function refreshCorpus({
    client, accountId, root = process.cwd(),
    configPath = path.join(root, 'wrangler.toml'),
    project = 'sg', force = false, wait = waitForMutation,
}) {
    const original = await readFile(configPath, 'utf8');
    const corpus = await buildCorpus({ root });
    const updated = setCorpusNamespace(original, corpus.namespace);
    let activeNamespace;
    if (!force) {
        const info = await client.pages.projects.get(project, { account_id: accountId });
        if (info.canonical_deployment?.id) {
            const active = await client.pages.projects.deployments.get(
                info.canonical_deployment.id, { account_id: accountId, project_name: project });
            if (active?.id !== info.canonical_deployment.id || active.environment !== 'production') {
                throw new Error('Invalid active production deployment snapshot');
            }
            const setting = active.env_vars?.AI_CORPUS_NAMESPACE;
            if (setting && (setting.type !== 'plain_text' || !/^corpus-[a-f0-9]{56}$/.test(setting.value))) {
                throw new Error('Invalid active corpus namespace');
            }
            activeNamespace = setting?.value;
        }
    }
    const skipped = activeNamespace === corpus.namespace;
    // Process one upload batch at a time so no later batch can hide its readiness marker.
    const result = skipped
        ? { namespace: corpus.namespace, count: corpus.chunks.length, mutationIds: [] }
        : await ingestCorpus(client, accountId, corpus, {
            namespace: corpus.namespace,
            afterMutation: mutationId => wait(client, accountId, mutationId),
        });
    if (await readFile(configPath, 'utf8') !== original) {
        throw new Error('Wrangler configuration changed during ingestion; refusing to overwrite');
    }
    await writeFile(configPath, updated);
    return { ...result, skipped };
}
