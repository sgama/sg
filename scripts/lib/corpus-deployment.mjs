import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pLimit from 'p-limit';
import { randomUUID } from 'node:crypto';
import Cloudflare from 'cloudflare';
import { buildCorpus } from './corpus.mjs';
import { INSTANCE_SETTINGS, VERSIONED_INSTANCE, validateCorpus } from './corpus-contract.mjs';
import { activeWorker } from './worker-deployment.mjs';

/** AI Search namespace that holds the portfolio instances. */
export const NAMESPACE = 'default';

/**
 * @param {string} apiToken
 * @param {typeof globalThis.fetch} [fetch]
 */
export function createMaintenanceClient(apiToken, fetch = globalThis.fetch) {
    return new Cloudflare({ apiToken, fetch, maxRetries: 2, timeout: 30000 });
}

/** @typedef {Awaited<ReturnType<typeof import('./corpus.mjs').buildCorpus>>} Corpus */

/** @param {unknown} error */
const notFound = (error) => error instanceof Error && 'status' in error && error.status === 404;

/**
 * Item statuses by key, or null when the instance does not exist.
 * @param {import('cloudflare').Cloudflare} client
 * @param {string} accountId
 * @param {string} instance
 * @returns {Promise<Map<string, { status: string, error?: string }> | null>}
 */
export async function instanceItems(client, accountId, instance) {
    const { instances } = client.aiSearch.namespaces;
    try {
        await instances.read(instance, { account_id: accountId, name: NAMESPACE });
    } catch (error) {
        if (notFound(error)) return null;
        throw error;
    }
    /** @type {Map<string, { status: string, error?: string }>} */
    const items = new Map();
    for await (const item of instances.items.list(instance, { account_id: accountId, name: NAMESPACE, per_page: 100 })) {
        items.set(item.key, { status: item.status, error: item.error });
    }
    return items;
}

/**
 * Whether the instance holds exactly the corpus items, all indexed.
 * @param {Map<string, { status: string }> | null} items
 * @param {Corpus} corpus
 */
export const instanceComplete = (items, corpus) =>
    !!items && items.size === corpus.items.length && corpus.items.every((item) => items.get(item.key)?.status === 'completed');

/**
 * Uploads one item as a hand-built multipart body: the SDK's file helpers reduce a filename to its basename, which
 * would drop the directories from the item key. Never retried (an upload can trigger paid embedding).
 * @param {import('cloudflare').Cloudflare} client
 * @param {string} accountId
 * @param {string} instance
 * @param {{ key: string, text: string, metadata: object }} item
 * @param {AbortSignal} signal
 */
async function uploadItem(client, accountId, instance, item, signal) {
    const boundary = `----sg-${randomUUID()}`;
    const body =
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${item.key}"\r\nContent-Type: text/markdown\r\n\r\n${item.text}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(item.metadata)}\r\n--${boundary}--\r\n`;
    await client.post(
        `/accounts/${encodeURIComponent(accountId)}/ai-search/namespaces/${NAMESPACE}/instances/${encodeURIComponent(instance)}/items`,
        {
            body,
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            maxRetries: 0,
            signal,
        },
    );
}

/**
 * Creates the instance when missing, uploads items that are not already indexed, and waits until every item is
 * indexed. Uploads are never retried (each can trigger paid embedding); the first failure aborts the rest. A rerun
 * resumes: items already completed in an existing instance are not uploaded again.
 * @param {import('cloudflare').Cloudflare} client
 * @param {string} accountId
 * @param {Corpus} corpus
 * @param {{
 *     instance?: string,
 *     force?: boolean,
 *     concurrency?: number,
 *     timeoutMs?: number,
 *     intervalMs?: number,
 *     gatewayId?: string,
 *     sleep?: (ms: number, signal: AbortSignal) => Promise<unknown>,
 * }} [options]
 */
export async function ingestCorpus(
    client,
    accountId,
    corpus,
    {
        instance,
        force = false,
        concurrency = 3,
        timeoutMs = 600000,
        intervalMs = 3000,
        gatewayId = process.env.AI_GATEWAY_ID,
        sleep = (ms, signal) => delay(ms, undefined, { signal }),
    } = {},
) {
    validateCorpus(corpus);
    if (!instance || instance !== corpus.instance) throw new Error(`Explicit --instance must match computed instance: ${corpus.instance}`);
    if (!accountId) throw new Error('Account ID is required');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) throw new Error('Concurrency must be 1–5');
    if (!corpus.items.length) throw new Error('Refusing to ingest an empty corpus');
    const { instances } = client.aiSearch.namespaces;
    const existing = await instanceItems(client, accountId, instance);
    if (!existing) {
        await instances.create(NAMESPACE, {
            account_id: accountId,
            id: instance,
            ...INSTANCE_SETTINGS,
            embedding_model: corpus.index.embeddingModel,
            reranking_model: corpus.index.reranker,
            chunk_size: corpus.index.chunkSize,
            chunk_overlap: corpus.index.chunkOverlap,
            ...(gatewayId ? { ai_gateway_id: gatewayId } : {}),
        });
    }
    const pending = corpus.items.filter((item) => force || existing?.get(item.key)?.status !== 'completed');
    const limit = pLimit(concurrency);
    const controller = new AbortController();
    await Promise.all(
        pending.map((item) =>
            limit(async () => {
                controller.signal.throwIfAborted();
                try {
                    await uploadItem(client, accountId, instance, item, controller.signal);
                } catch (error) {
                    controller.abort(error);
                    throw controller.signal.reason;
                }
            }),
        ),
    );
    await waitForItems(client, accountId, corpus, { instance, timeoutMs, intervalMs, sleep });
    return { instance, count: corpus.items.length, uploaded: pending.length, reused: corpus.items.length - pending.length };
}

/**
 * Polls until every corpus item is completed; an errored or skipped item, or a timeout, fails.
 * @param {import('cloudflare').Cloudflare} client
 * @param {string} accountId
 * @param {Corpus} corpus
 * @param {{ instance: string, timeoutMs?: number, intervalMs?: number, sleep?: (ms: number, signal: AbortSignal) => Promise<unknown> }} options
 */
export async function waitForItems(
    client,
    accountId,
    corpus,
    { instance, timeoutMs = 600000, intervalMs = 3000, sleep = (ms, signal) => delay(ms, undefined, { signal }) },
) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
        while (true) {
            const items = await instanceItems(client, accountId, instance);
            signal.throwIfAborted();
            if (!items) throw new Error(`AI Search instance ${instance} does not exist`);
            for (const [key, { status, error }] of items) {
                if (status === 'error' || status === 'skipped') throw new Error(`AI Search item ${key} ${status}${error ? `: ${error}` : ''}`);
            }
            if (instanceComplete(items, corpus)) return;
            if (items.size > corpus.items.length) throw new Error(`AI Search instance ${instance} holds unexpected items`);
            await sleep(intervalMs, signal);
        }
    } catch (error) {
        if (signal.aborted) throw new Error(`Timed out waiting for AI Search instance ${instance} to index`, { cause: error });
        throw error;
    }
}

/**
 * @param {string} config wrangler.toml text
 * @param {string} instance
 * @param {string} [previousInstance]
 */
export function setSearchInstance(config, instance, previousInstance) {
    if (!VERSIONED_INSTANCE.test(instance)) throw new Error('Invalid AI Search instance');
    if (previousInstance !== undefined && !VERSIONED_INSTANCE.test(previousInstance)) throw new Error('Invalid previous AI Search instance');
    const sections = config.split(/(^\[[^\r\n]+\][ \t]*\r?$)/m);
    const index = sections.findIndex((section) => section === '[vars]');
    if (index === -1 || index + 1 >= sections.length) throw new Error('Wrangler [vars] section is required');
    const entries = sections[index + 1].match(/^AI_SEARCH_INSTANCE\s*=.*$/gm) ?? [];
    if (entries.length > 1) throw new Error('Duplicate AI_SEARCH_INSTANCE settings');
    const prevEntries = sections[index + 1].match(/^AI_PREVIOUS_SEARCH_INSTANCE\s*=.*$/gm) ?? [];
    if (prevEntries.length > 1) throw new Error('Duplicate AI_PREVIOUS_SEARCH_INSTANCE settings');
    const setting = `AI_SEARCH_INSTANCE = "${instance}"`;
    let varsSection = sections[index + 1];
    varsSection = entries.length ? varsSection.replace(/^AI_SEARCH_INSTANCE\s*=.*$/m, setting) : `\n${setting}${varsSection}`;
    if (previousInstance !== undefined) {
        const previousSetting = `AI_PREVIOUS_SEARCH_INSTANCE = "${previousInstance}"`;
        varsSection = prevEntries.length
            ? varsSection.replace(/^AI_PREVIOUS_SEARCH_INSTANCE\s*=.*$/m, previousSetting)
            : varsSection.replace(/^AI_SEARCH_INSTANCE\s*=.*$/m, `${setting}\n${previousSetting}`);
    } else if (prevEntries.length) {
        varsSection = varsSection.replace(/^AI_PREVIOUS_SEARCH_INSTANCE\s*=.*\r?\n?/m, '');
    }
    sections[index + 1] = varsSection;
    return sections.join('');
}

/**
 * @param {{
 *     client: import('cloudflare').Cloudflare,
 *     accountId: string,
 *     root?: string,
 *     configPath?: string,
 *     worker?: string,
 *     force?: boolean,
 *     ingest?: typeof ingestCorpus,
 * }} options
 */
export async function refreshCorpus({
    client,
    accountId,
    root = process.cwd(),
    configPath = path.join(root, 'wrangler.toml'),
    worker = 'sg',
    force = false,
    ingest = ingestCorpus,
}) {
    const original = await readFile(configPath, 'utf8');
    const corpus = await buildCorpus({ root });
    // Always read the live Worker so the instance it serves becomes the new previous one. A forced refresh still
    // ingests when that lookup fails; it then records no previous instance.
    const active = await activeWorker(client, accountId, worker).catch((error) => {
        if (!force) throw error;
        return null;
    });
    const activeInstance = active?.instance;
    const previousInstance = activeInstance === corpus.instance ? active?.previousInstance : activeInstance;
    const updated = setSearchInstance(original, corpus.instance, previousInstance);
    // The live instance is only skipped when it still exists and holds the whole corpus.
    const skipped = !force && activeInstance === corpus.instance && instanceComplete(await instanceItems(client, accountId, corpus.instance), corpus);
    const result = skipped
        ? { instance: corpus.instance, count: corpus.items.length, uploaded: 0, reused: corpus.items.length }
        : await ingest(client, accountId, corpus, { instance: corpus.instance, force });
    if ((await readFile(configPath, 'utf8')) !== original) {
        throw new Error('Wrangler configuration changed during ingestion; refusing to overwrite');
    }
    await writeFile(configPath, updated);
    return { ...result, skipped };
}
