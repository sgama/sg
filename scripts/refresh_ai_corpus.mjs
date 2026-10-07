import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Cloudflare from 'cloudflare';
import 'dotenv/config';
import { refreshCorpus } from './lib/corpus-deployment.mjs';

export async function main(args = process.argv.slice(2)) {
    const { values } = parseArgs({ args, options: { config: { type: 'string', default: 'wrangler.toml' } } });
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = process.env;
    if (!accountId || !apiToken) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
    const result = await refreshCorpus({
        client: new Cloudflare({ apiToken, maxRetries: 0, timeout: 30000 }),
        accountId, configPath: values.config,
    });
    console.log(`Corpus ready: ${result.namespace} (${result.count} chunks). Deployment configuration updated.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`Corpus refresh failed: ${error.message}`);
        process.exitCode = 1;
    });
}
