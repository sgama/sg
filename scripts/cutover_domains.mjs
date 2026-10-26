import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createMaintenanceClient } from './lib/corpus-deployment.mjs';
import { requireCloudflareCredentials } from './lib/cloudflare-ai.mjs';
import { runIfMain } from './lib/cli.mjs';

/**
 * One-time move of the Pages project's custom domains to the Worker. Per hostname: detach from Pages, attach to the
 * Worker, and re-attach to Pages if the Worker attachment fails, so a failure never leaves a hostname unserved.
 */
export async function cutoverDomains({ client, accountId, project = 'sg', worker = 'sg', zone, dryRun = false, log = console.error }) {
    const domains = [];
    for await (const domain of client.pages.projects.domains.list(project, { account_id: accountId })) {
        if (!domain.name.endsWith('.pages.dev')) domains.push(domain.name);
    }
    const moved = [];
    for (const hostname of domains) {
        log(`${dryRun ? 'would move' : 'moving'} ${hostname}: Pages ${project} -> Worker ${worker}`);
        if (dryRun) continue;
        await client.pages.projects.domains.delete(hostname, { account_id: accountId, project_name: project });
        try {
            await client.workers.domains.update({ account_id: accountId, hostname, service: worker, zone_name: zone });
        } catch (error) {
            let restoreError;
            try {
                await client.pages.projects.domains.create(project, { account_id: accountId, name: hostname });
            } catch (pagesError) {
                restoreError = pagesError;
            }
            const attachFailure = new Error(`Could not attach ${hostname} to Worker ${worker} after detaching it from Pages.`);
            attachFailure.cause = error;
            if (restoreError) {
                const restoreFailure = new Error(
                    `Also failed to restore ${hostname} to Pages after the Worker attach error. Manual recovery: reattach ${hostname} on Pages or inspect the domain state.`,
                );
                restoreFailure.cause = restoreError;
                const rollbackFailure = new AggregateError(
                    [attachFailure, restoreFailure],
                    `Could not attach ${hostname} to Worker ${worker}; restore on Pages failed too. Manual recovery: reattach ${hostname} on Pages or inspect the domain state.`,
                );
                rollbackFailure.cause = attachFailure;
                throw rollbackFailure;
            }
            const restoredFailure = new Error(
                `Could not attach ${hostname} to Worker ${worker}; restored it on Pages. Manual recovery: confirm ${hostname} is attached correctly on Pages or the Worker.`,
            );
            restoredFailure.cause = attachFailure;
            throw restoredFailure;
        }
        moved.push(hostname);
    }
    return { dryRun, hostnames: domains, moved };
}

export async function main(args = process.argv.slice(2), { fetchImpl = globalThis.fetch } = {}) {
    const { values } = parseArgs({ args, options: { zone: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
    if (!values.zone) throw new Error('Missing --zone (for example --zone samsongama.com)');
    const { accountId, apiToken } = requireCloudflareCredentials();
    const result = await cutoverDomains({
        client: createMaintenanceClient(apiToken, fetchImpl),
        accountId,
        project: process.env.PAGES_PROJECT ?? 'sg',
        worker: process.env.WORKER_NAME ?? 'sg',
        zone: values.zone,
        dryRun: values['dry-run'],
    });
    console.log(JSON.stringify(result, null, 2));
}

runIfMain(import.meta.url, main, 'Domain cutover failed');
