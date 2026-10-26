import 'dotenv/config';
import { parseArgs } from 'node:util';
import pLimit from 'p-limit';
import { AI_CONFIG } from '../functions/_lib/application.js';
import { createMaintenanceClient, waitForMutation } from './lib/corpus-deployment.mjs';
import { requireCloudflareCredentials } from './lib/cloudflare-ai.mjs';
import { VERSIONED_NAMESPACE, activeWorker } from './lib/worker-deployment.mjs';
import { runIfMain } from './lib/cli.mjs';

/** Every vector with its namespace: lists IDs (1000 per page), then fetches records in batches of 100. */
async function vectorInventory(client, accountId, indexName, progress) {
    const vectors = [];
    const seen = new Set();
    const cursors = new Set();
    let cursor;
    let pageNumber = 0;
    do {
        const page = await client.vectorize.indexes.listVectors(indexName, {
            account_id: accountId,
            count: 1000,
            ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(page?.vectors) || typeof page.isTruncated !== 'boolean') {
            throw new Error('Invalid vector inventory response');
        }
        const ids = page.vectors.map((vector) => vector.id);
        if (ids.some((id) => typeof id !== 'string' || !id || seen.has(id))) {
            throw new Error('Invalid or repeated vector ID during cleanup');
        }
        ids.forEach((id) => seen.add(id));
        const batches = [];
        for (let offset = 0; offset < ids.length; offset += 100) {
            batches.push(ids.slice(offset, offset + 100));
        }
        progress(`page ${++pageNumber}: ${ids.length} vectors (${seen.size} total, ${batches.length} record batches)`);
        const limit = pLimit(10);
        const results = await Promise.all(
            batches.map((batch) =>
                limit(async () => {
                    const records = await client.vectorize.indexes.getByIDs(indexName, {
                        account_id: accountId,
                        ids: batch,
                    });
                    if (
                        !Array.isArray(records) ||
                        records.length !== batch.length ||
                        new Set(records.map((record) => record.id)).size !== batch.length ||
                        records.some((record) => !batch.includes(record.id))
                    ) {
                        throw new Error('Incomplete vector records; refusing cleanup');
                    }
                    return records;
                }),
            ),
        );
        vectors.push(...results.flat());
        if (!page.isTruncated) break;
        cursor = page.nextCursor;
        if (!cursor || cursors.has(cursor)) throw new Error('Invalid vector inventory cursor');
        cursors.add(cursor);
    } while (true);
    return vectors;
}

/**
 * Deletes the vectors of every versioned corpus namespace except the one the live Worker queries (one live deployment,
 * so older corpora are dead weight). Unversioned and foreign namespaces are never touched. The live namespace is
 * re-read before each deletion, so a deploy that lands mid-run stops the cleanup instead of racing it.
 */
export async function cleanupVectors({
    client,
    accountId,
    worker = 'sg',
    indexName = AI_CONFIG.retrieval.indexName,
    dryRun = false,
    wait = waitForMutation,
    progress = /** @type {(message: string) => void} */ (() => {}),
}) {
    const started = performance.now();
    const mark = (message) => progress(`[${((performance.now() - started) / 1000).toFixed(1)}s] ${message}`);
    const live = (await activeWorker(client, accountId, worker))?.namespace;
    if (!live) throw new Error('Cannot determine the live corpus namespace; refusing vector cleanup');
    const vectors = await vectorInventory(client, accountId, indexName, mark);
    const staleIds = vectors.filter((vector) => VERSIONED_NAMESPACE.test(vector.namespace) && vector.namespace !== live).map((vector) => vector.id);
    mark(`live ${live}: ${vectors.length} vectors, ${staleIds.length} stale`);
    if (!dryRun) {
        let lastMutationId;
        mark(`deleting ${staleIds.length} vectors`);
        for (let offset = 0; offset < staleIds.length; offset += 100) {
            const batch = staleIds.slice(offset, offset + 100);
            mark(`delete ${Math.min(offset + 100, staleIds.length)}/${staleIds.length}`);
            if ((await activeWorker(client, accountId, worker))?.namespace !== live) {
                throw new Error('Live corpus namespace changed during cleanup; stopping');
            }
            const result = await client.vectorize.indexes.deleteByIDs(indexName, {
                account_id: accountId,
                ids: batch,
            });
            if (typeof result?.mutationId !== 'string' || !result.mutationId.trim()) throw new Error('Vector deletion did not return a mutation ID');
            lastMutationId = result.mutationId;
        }
        // Mutations are processed in order, so waiting for the last one covers them all.
        if (lastMutationId) {
            mark(`waiting for mutation ${lastMutationId}`);
            await wait(client, accountId, lastMutationId, { indexName });
        }
        mark('done');
    }
    return { dryRun, liveNamespace: live, removedVectors: staleIds.length };
}

export async function main(args = process.argv.slice(2), { fetchImpl = globalThis.fetch } = {}) {
    const { values } = parseArgs({ args, options: { 'dry-run': { type: 'boolean', default: false } } });
    const { accountId, apiToken } = requireCloudflareCredentials();
    const result = await cleanupVectors({
        client: createMaintenanceClient(apiToken, fetchImpl),
        accountId,
        worker: process.env.WORKER_NAME ?? 'sg',
        dryRun: values['dry-run'],
        progress: (message) => console.error(message),
    });
    console.log(JSON.stringify(result, null, 2));
}

runIfMain(import.meta.url, main, 'Vector cleanup failed');
