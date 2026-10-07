import Cloudflare from 'cloudflare';
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AI_CONFIG } from '../functions/_lib/application.js';
import { waitForMutation } from './lib/corpus-deployment.mjs';

const VERSIONED_NAMESPACE = /^corpus-[a-f0-9]{56}$/;
const successful = deployment => !deployment.is_skipped
    && deployment.latest_stage?.name === 'deploy'
    && deployment.latest_stage.status === 'success';

export function planRetention(deployments, activeId, branch, previous = 5) {
    if (!activeId || !deployments.some(deployment => deployment.id === activeId)) {
        throw new Error('Active deployment must be present before cleanup');
    }
    if (!Number.isInteger(previous) || previous < 0) throw new Error('Invalid deployment retention count');
    if (deployments.some(deployment => !deployment.id || !Number.isFinite(Date.parse(deployment.created_on)))) {
        throw new Error('Deployment inventory contains invalid IDs or timestamps');
    }
    const production = deployments.filter(deployment => deployment.environment === 'production'
        && deployment.deployment_trigger?.metadata?.branch === branch);
    const active = deployments.find(deployment => deployment.id === activeId);
    if (active.environment !== 'production') {
        throw new Error('Active deployment is not production; refusing cleanup');
    }
    const predecessors = production.filter(deployment => deployment.id !== activeId
        && Date.parse(deployment.created_on) < Date.parse(active.created_on)
        && successful(deployment))
        .sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))
        .slice(0, previous);
    const keep = new Set([activeId, ...predecessors.map(deployment => deployment.id)]);
    // Production builds in progress survive; previews are removed regardless of status.
    const remove = deployments.filter(deployment => deployment.environment === 'preview'
        || (production.some(item => item.id === deployment.id) && !keep.has(deployment.id)
            && ['success', 'failure', 'canceled'].includes(deployment.latest_stage?.status)));
    return {
        remove,
        retain: deployments.filter(deployment => !remove.some(item => item.id === deployment.id)),
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

async function inventory(client, project, accountId) {
    const result = [];
    for await (const deployment of client.pages.projects.deployments.list(project, { account_id: accountId })) {
        // Fetch the deployment snapshot rather than current project-wide environment variables.
        result.push(await client.pages.projects.deployments.get(project, deployment.id, { account_id: accountId }));
    }
    return result;
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
            account_id: accountId, count: 1000, ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(page?.vectors) || typeof page.isTruncated !== 'boolean') {
            throw new Error('Invalid vector inventory response');
        }
        const ids = page.vectors.map(vector => vector.id);
        if (ids.some(id => typeof id !== 'string' || !id || seen.has(id))) {
            throw new Error('Invalid or repeated vector ID during cleanup');
        }
        ids.forEach(id => seen.add(id));
        for (let offset = 0; offset < ids.length; offset += 20) {
            const batch = ids.slice(offset, offset + 20);
            const records = await client.vectorize.indexes.getByIds(indexName, { account_id: accountId, ids: batch });
            if (!Array.isArray(records) || records.length !== batch.length
                || new Set(records.map(record => record.id)).size !== batch.length
                || records.some(record => !batch.includes(record.id))) {
                throw new Error('Incomplete vector records; refusing cleanup');
            }
            vectors.push(...records);
        }
        if (!page.isTruncated) break;
        cursor = page.nextCursor;
        if (!cursor || cursors.has(cursor)) throw new Error('Invalid vector inventory cursor');
        cursors.add(cursor);
    } while (true);
    return vectors;
}

export async function cleanupDeployments({
    client, accountId, project = 'sg', branch = 'develop', previous = 5,
    indexName = AI_CONFIG.retrieval.indexName, dryRun = false, wait = waitForMutation,
}) {
    const activeId = await activeDeployment(client, project, accountId);
    const deployments = await inventory(client, project, accountId);
    const plan = planRetention(deployments, activeId, branch, previous);
    const referenced = referencedNamespaces(plan.retain);
    const vectors = await vectorInventory(client, accountId, indexName);
    const staleIds = vectors.filter(vector => VERSIONED_NAMESPACE.test(vector.namespace)
        && !referenced.has(vector.namespace)).map(vector => vector.id);
    const assertStable = async (expected) => {
        if (await activeDeployment(client, project, accountId) !== activeId) {
            throw new Error('Active deployment changed during cleanup; stopping');
        }
        const latest = await inventory(client, project, accountId);
        const currentIds = latest.map(deployment => deployment.id).sort();
        if (JSON.stringify(currentIds) !== JSON.stringify([...expected].sort())
            || JSON.stringify([...referencedNamespaces(latest.filter(deployment =>
                plan.retain.some(item => item.id === deployment.id)))].sort())
                !== JSON.stringify([...referenced].sort())) {
            throw new Error('Deployment inventory changed during cleanup; stopping');
        }
    };
    const remaining = new Set(deployments.map(deployment => deployment.id));
    await assertStable(remaining);
    if (!dryRun) {
        for (const deployment of plan.remove) {
            await assertStable(remaining);
            await client.pages.projects.deployments.delete(project, deployment.id, { account_id: accountId });
            remaining.delete(deployment.id);
        }
        // Never remove vectors until all obsolete deployments have been deleted.
        for (let offset = 0; offset < staleIds.length; offset += 100) {
            await assertStable(remaining);
            const result = await client.vectorize.indexes.deleteByIds(indexName, {
                account_id: accountId, ids: staleIds.slice(offset, offset + 100),
            });
            if (typeof result?.mutationId !== 'string' || !result.mutationId.trim()) {
                throw new Error('Vector deletion did not return a mutation ID');
            }
            await wait(client, accountId, result.mutationId, { indexName });
        }
        await assertStable(remaining);
    }
    return { dryRun, retainedDeployments: plan.retain.map(item => item.id),
        removedDeployments: plan.remove.map(item => item.id), removedVectors: staleIds.length };
}

export async function main(args = process.argv.slice(2)) {
    const { values } = parseArgs({ args, options: { 'dry-run': { type: 'boolean', default: false } } });
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = process.env;
    if (!accountId || !apiToken) throw new Error('Missing Cloudflare credentials');
    const result = await cleanupDeployments({
        client: new Cloudflare({ apiToken, maxRetries: 0, timeout: 30000 }), accountId,
        project: process.env.PROJECT_NAME ?? 'sg', branch: process.env.BRANCH ?? 'develop',
        dryRun: values['dry-run'],
    });
    console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`Deployment/corpus cleanup failed: ${error.message}`);
        process.exitCode = 1;
    });
}
