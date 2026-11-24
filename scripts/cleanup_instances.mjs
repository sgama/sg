import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createMaintenanceClient, NAMESPACE } from './lib/corpus-deployment.mjs';
import { requireCloudflareCredentials } from './lib/cloudflare-ai.mjs';
import { VERSIONED_INSTANCE } from './lib/corpus-contract.mjs';
import { activeWorker } from './lib/worker-deployment.mjs';
import { runIfMain } from './lib/cli.mjs';

/**
 * Deletes versioned AI Search instances other than the live Worker's and its recorded previous one. Unversioned and
 * foreign instances are never touched. The live + previous pair is re-read before each deletion, so a deploy that lands
 * mid-run stops the cleanup instead of racing it.
 * @param {{
 *     client: import('cloudflare').Cloudflare,
 *     accountId: string,
 *     worker?: string,
 *     dryRun?: boolean,
 *     progress?: (message: string) => void,
 * }} options
 */
export async function cleanupInstances({
    client,
    accountId,
    worker = 'sg',
    dryRun = false,
    progress = /** @type {(message: string) => void} */ (() => {}),
}) {
    const active = await activeWorker(client, accountId, worker);
    const live = active?.instance;
    if (!live) throw new Error('Cannot determine the live AI Search instance; refusing instance cleanup');
    const previous = active.previousInstance;
    const retained = new Set([live]);
    if (previous) retained.add(previous);
    const { instances } = client.aiSearch.namespaces;
    /** @type {string[]} */
    const ids = [];
    for await (const instance of instances.list(NAMESPACE, { account_id: accountId, search: 'portfolio-', per_page: 100 })) ids.push(instance.id);
    if (new Set(ids).size !== ids.length) throw new Error('Repeated instance ID during cleanup');
    const stale = ids.filter((id) => VERSIONED_INSTANCE.test(id) && !retained.has(id));
    progress(`live ${live}${previous ? `, previous ${previous}` : ''}: ${ids.length} instances, ${stale.length} stale`);
    if (!dryRun) {
        for (const id of stale) {
            const current = await activeWorker(client, accountId, worker);
            if (current?.instance !== live || current?.previousInstance !== previous) {
                throw new Error('Live AI Search instance changed during cleanup; stopping');
            }
            progress(`deleting ${id}`);
            await instances.delete(id, { account_id: accountId, name: NAMESPACE });
        }
        progress('done');
    }
    return { dryRun, liveInstance: live, removedInstances: stale.length };
}

/**
 * @param {string[]} [args]
 * @param {{ fetchImpl?: typeof globalThis.fetch }} [options]
 */
export async function main(args = process.argv.slice(2), { fetchImpl = globalThis.fetch } = {}) {
    const { values } = parseArgs({ args, options: { 'dry-run': { type: 'boolean', default: false } } });
    const { accountId, apiToken } = requireCloudflareCredentials();
    const result = await cleanupInstances({
        client: createMaintenanceClient(apiToken, fetchImpl),
        accountId,
        worker: process.env.WORKER_NAME ?? 'sg',
        dryRun: values['dry-run'],
        progress: (message) => console.error(message),
    });
    console.log(JSON.stringify(result, null, 2));
}

runIfMain(import.meta.url, main, 'Instance cleanup failed');
