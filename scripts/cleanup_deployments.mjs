import 'dotenv/config';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import pLimit from 'p-limit';
import { AI_CONFIG } from '../functions/_lib/application.js';
import { createMaintenanceClient, waitForMutation } from './lib/corpus-deployment.mjs';
import { requireCloudflareCredentials } from './lib/cloudflare-ai.mjs';
import { runIfMain } from './lib/cli.mjs';

// Deployment-retention planning is pure (no I/O): callers supply the inventory.
const VERSIONED_NAMESPACE = /^corpus-[a-f0-9]{56}$/;
const successful = (deployment) =>
    !deployment.is_skipped && deployment.latest_stage?.name === 'deploy' && deployment.latest_stage.status === 'success';
// 'idle' (queued) and 'active' (building) are the only non-terminal stages.
const TERMINAL_STAGES = new Set(['success', 'failure', 'canceled', 'skipped']);
// A build still queued or running after this long is dead, not in progress.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * What to keep: the active production deployment, plus `previous` older successful production deployments on
 * `branch` (default none: one production deployment). Everything else is removed: every preview, and every other
 * production deployment of any branch once it has finished or has been stuck in progress past `staleAfterMs`.
 */
export function planRetention(deployments, activeId, branch, previous = 0, { now = Date.now(), staleAfterMs = STALE_AFTER_MS } = {}) {
    if (!activeId || !deployments.some((deployment) => deployment.id === activeId)) {
        throw new Error('Active deployment must be present before cleanup');
    }
    if (!Number.isInteger(previous) || previous < 0) throw new Error('Invalid deployment retention count');
    if (deployments.some((deployment) => !deployment.id || !Number.isFinite(Date.parse(deployment.created_on)))) {
        throw new Error('Deployment inventory contains invalid IDs or timestamps');
    }
    const active = deployments.find((deployment) => deployment.id === activeId);
    if (active.environment !== 'production') {
        throw new Error('Active deployment is not production; refusing cleanup');
    }
    const predecessors = deployments
        .filter(
            (deployment) =>
                deployment.environment === 'production' &&
                deployment.deployment_trigger?.metadata?.branch === branch &&
                deployment.id !== activeId &&
                Date.parse(deployment.created_on) < Date.parse(active.created_on) &&
                successful(deployment),
        )
        .sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))
        .slice(0, previous);
    const keep = new Set([activeId, ...predecessors.map((deployment) => deployment.id)]);
    const finished = (deployment) =>
        TERMINAL_STAGES.has(deployment.is_skipped ? 'skipped' : deployment.latest_stage?.status) ||
        now - Date.parse(deployment.created_on) > staleAfterMs;
    const remove = deployments
        .filter(
            (deployment) =>
                deployment.environment === 'preview' || (deployment.environment === 'production' && !keep.has(deployment.id) && finished(deployment)),
        )
        .sort((a, b) => Date.parse(a.created_on) - Date.parse(b.created_on));
    return {
        remove,
        retain: deployments.filter((deployment) => !remove.some((item) => item.id === deployment.id)),
    };
}

export function referencedNamespaces(deployments) {
    const namespaces = new Set();
    for (const deployment of deployments) {
        const setting = deployment.env_vars?.AI_CORPUS_NAMESPACE;
        if (setting?.type !== 'plain_text' || !VERSIONED_NAMESPACE.test(setting.value)) {
            throw new Error(`Cannot determine corpus namespace for retained deployment ${deployment.id}; refusing vector cleanup`);
        }
        namespaces.add(setting.value);
    }
    return namespaces;
}

// Groups deployments by what decides their fate (environment, branch, last stage) so a dry run shows why each is kept.
function breakdown(deployments) {
    const groups = {};
    for (const deployment of deployments) {
        const key = [
            deployment.environment,
            deployment.deployment_trigger?.metadata?.branch ?? 'no branch',
            deployment.is_skipped ? 'skipped' : `${deployment.latest_stage?.name}:${deployment.latest_stage?.status}`,
        ].join(' / ');
        const group = (groups[key] ??= { count: 0, oldest: deployment.created_on });
        group.count++;
        if (Date.parse(deployment.created_on) < Date.parse(group.oldest)) group.oldest = deployment.created_on;
    }
    return groups;
}

async function inventory(client, project, accountId) {
    const result = [];
    for await (const deployment of client.pages.projects.deployments.list(project, {
        account_id: accountId,
    })) {
        result.push(deployment);
    }
    return result;
}

async function retainedSnapshots(client, project, accountId, deployments) {
    const limit = pLimit(5);
    const snapshots = await Promise.all(
        deployments.map((deployment) =>
            limit(async () => {
                const snapshot = await client.pages.projects.deployments.get(deployment.id, {
                    account_id: accountId,
                    project_name: project,
                });
                if (snapshot?.id !== deployment.id || snapshot.environment !== deployment.environment) {
                    throw new Error('Invalid retained deployment snapshot; refusing cleanup');
                }
                return snapshot;
            }),
        ),
    );
    return snapshots;
}

async function activeDeployment(client, project, accountId) {
    const info = await client.pages.projects.get(project, { account_id: accountId });
    if (!info.canonical_deployment?.id) throw new Error('Project has no canonical deployment; refusing cleanup');
    return info.canonical_deployment.id;
}

async function vectorInventory(client, accountId, indexName) {
    const vectors = [];
    const seen = new Set();
    const cursors = new Set();
    let cursor;
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
        for (let offset = 0; offset < ids.length; offset += 20) {
            batches.push(ids.slice(offset, offset + 20));
        }
        const limit = pLimit(5);
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

export async function cleanupDeployments({
    client,
    accountId,
    project = 'sg',
    branch = 'develop',
    previous = 0,
    maxDeletes = 100,
    concurrency = 5,
    now = Date.now(),
    indexName = AI_CONFIG.retrieval.indexName,
    dryRun = false,
    verbose = false,
    wait = waitForMutation,
    sleep = delay,
}) {
    const activeId = await activeDeployment(client, project, accountId);
    const deployments = await inventory(client, project, accountId);
    if (!Number.isInteger(maxDeletes) || maxDeletes < 1) throw new Error('Invalid maximum deletions per run');
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid deletion concurrency');
    const plan = planRetention(deployments, activeId, branch, previous, { now });
    // Oldest first, a bounded batch per run: a large backlog is worked off over several deploys, and each deletion
    // re-checks every retained deployment, so the cap bounds how long one run can take.
    const batch = plan.remove.slice(0, maxDeletes);
    const deferred = plan.remove.length - batch.length;
    const retainedIds = new Set(plan.retain.map((deployment) => deployment.id));
    const references = async (deployments) => referencedNamespaces(await retainedSnapshots(client, project, accountId, deployments));
    const referenced = await references(plan.retain);
    const vectors = await vectorInventory(client, accountId, indexName);
    const staleIds = vectors
        .filter((vector) => VERSIONED_NAMESPACE.test(vector.namespace) && !referenced.has(vector.namespace))
        .map((vector) => vector.id);
    const deletedIds = new Set();
    const assertStable = async (expected) => {
        for (let attempt = 0; attempt < 5; attempt++) {
            if ((await activeDeployment(client, project, accountId)) !== activeId) {
                throw new Error('Active deployment changed during cleanup; stopping');
            }
            const latest = await inventory(client, project, accountId);
            const currentIds = new Set(latest.map((deployment) => deployment.id));
            const added = [...currentIds].filter((id) => !expected.has(id) && !deletedIds.has(id));
            const missing = [...expected].filter((id) => !currentIds.has(id));
            if (added.length || missing.length) {
                throw new Error(
                    `Deployment inventory changed during cleanup; stopping (unexpected: ${added.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`,
                );
            }
            const currentReferences = await references(latest.filter((deployment) => retainedIds.has(deployment.id)));
            if (JSON.stringify([...currentReferences].sort()) !== JSON.stringify([...referenced].sort())) {
                throw new Error('Deployment inventory changed during cleanup; stopping (retained corpus namespaces changed)');
            }
            const pending = [...currentIds].filter((id) => deletedIds.has(id));
            if (!pending.length) return;
            if (attempt === 4) {
                throw new Error(`Deployment inventory changed during cleanup; stopping (acknowledged deletions still listed: ${pending.join(', ')})`);
            }
            // Only our acknowledged deletions may be stale; never retry unrelated inventory changes.
            await sleep(1000);
        }
    };
    // Deployments left over by the cap still exist, so their corpora must not be pruned yet.
    const vectorsToDelete = deferred ? [] : staleIds;
    const remaining = new Set(deployments.map((deployment) => deployment.id));
    await assertStable(remaining);
    if (!dryRun) {
        // The Pages API has no bulk delete, so deletions run a few at a time; the inventory is re-checked before each group.
        for (let offset = 0; offset < batch.length; offset += concurrency) {
            await assertStable(remaining);
            await Promise.all(
                batch.slice(offset, offset + concurrency).map(async (deployment) => {
                    await client.pages.projects.deployments.delete(deployment.id, {
                        account_id: accountId,
                        project_name: project,
                        ...(deployment.environment === 'preview' ? { force: true } : {}),
                    });
                    deletedIds.add(deployment.id);
                    remaining.delete(deployment.id);
                }),
            );
        }
        // Never remove vectors until all obsolete deployments have been deleted. Batches are the API maximum (100 IDs);
        // mutations are processed in order, so waiting for the last one covers them all.
        let lastMutationId;
        for (let offset = 0; offset < vectorsToDelete.length; offset += 100) {
            await assertStable(remaining);
            const result = await client.vectorize.indexes.deleteByIDs(indexName, {
                account_id: accountId,
                ids: vectorsToDelete.slice(offset, offset + 100),
            });
            if (typeof result?.mutationId !== 'string' || !result.mutationId.trim()) {
                throw new Error('Vector deletion did not return a mutation ID');
            }
            lastMutationId = result.mutationId;
        }
        if (lastMutationId) await wait(client, accountId, lastMutationId, { indexName });
        await assertStable(remaining);
    }
    return {
        dryRun,
        retainedDeployments: plan.retain.map((item) => item.id),
        removedDeployments: batch.map((item) => item.id),
        removedVectors: vectorsToDelete.length,
        ...(deferred ? { deferredDeployments: deferred } : {}),
        ...(verbose ? { retainedBreakdown: breakdown(plan.retain) } : {}),
    };
}

export async function main(args = process.argv.slice(2), { fetchImpl = globalThis.fetch } = {}) {
    const { values } = parseArgs({
        args,
        options: {
            'dry-run': { type: 'boolean', default: false },
            verbose: { type: 'boolean', default: false },
            keep: { type: 'string', default: '0' },
            'max-deletes': { type: 'string', default: '100' },
            concurrency: { type: 'string', default: '5' },
        },
    });
    const { accountId, apiToken } = requireCloudflareCredentials();
    const result = await cleanupDeployments({
        client: createMaintenanceClient(apiToken, fetchImpl),
        accountId,
        project: process.env.PROJECT_NAME ?? 'sg',
        branch: process.env.BRANCH ?? 'develop',
        dryRun: values['dry-run'],
        verbose: values.verbose,
        previous: Number(values.keep),
        maxDeletes: Number(values['max-deletes']),
        concurrency: Number(values.concurrency),
    });
    console.log(JSON.stringify(result, null, 2));
}

runIfMain(import.meta.url, main, 'Deployment/corpus cleanup failed');
