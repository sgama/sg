import { parseArgs } from 'node:util';
import 'dotenv/config';
import { requireCloudflareCredentials } from './lib/cloudflare-ai.mjs';
import { createMaintenanceClient, refreshCorpus } from './lib/corpus-deployment.mjs';
import { runIfMain } from './lib/cli.mjs';

export async function main(args = process.argv.slice(2), { fetchImpl = globalThis.fetch } = {}) {
    const { values } = parseArgs({
        args,
        options: {
            config: { type: 'string', default: 'wrangler.toml' },
            force: { type: 'boolean', default: false },
        },
    });
    const { accountId, apiToken } = requireCloudflareCredentials();
    const result = await refreshCorpus({
        client: createMaintenanceClient(apiToken, fetchImpl),
        accountId,
        configPath: values.config,
        force: values.force,
        worker: process.env.WORKER_NAME ?? 'sg',
    });
    console.log(
        `Corpus ${result.skipped ? 'unchanged; ingestion skipped' : 'indexed'}: ${result.namespace} (${result.count} chunks). Deployment configuration updated.`,
    );
}

runIfMain(import.meta.url, main, 'Corpus refresh failed');
