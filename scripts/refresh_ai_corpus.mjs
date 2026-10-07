import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import 'dotenv/config';
import { createMaintenanceClient, refreshCorpus } from './lib/corpus-deployment.mjs';

export async function main(args = process.argv.slice(2)) {
    const { values } = parseArgs({ args, options: {
        config: { type: 'string', default: 'wrangler.toml' },
        force: { type: 'boolean', default: false },
    } });
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = process.env;
    if (!accountId || !apiToken) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
    const result = await refreshCorpus({
        client: createMaintenanceClient(apiToken),
        accountId, configPath: values.config, force: values.force,
        project: process.env.PROJECT_NAME ?? 'sg',
    });
    console.log(`Corpus ${result.skipped ? 'unchanged; ingestion skipped' : 'indexed'}: ${result.namespace} (${result.count} chunks). Deployment configuration updated.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`Corpus refresh failed: ${error.message}`);
        process.exitCode = 1;
    });
}
