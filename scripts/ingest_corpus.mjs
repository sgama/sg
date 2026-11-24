import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildCorpus } from './lib/corpus.mjs';
import { requireCloudflareCredentials } from './lib/cloudflare-ai.mjs';
import { createMaintenanceClient, ingestCorpus } from './lib/corpus-deployment.mjs';
import { runIfMain } from './lib/cli.mjs';

/** @param {string[]} [args] */
export async function main(args = process.argv.slice(2)) {
    const { values } = parseArgs({
        args,
        options: {
            check: { type: 'boolean', default: false },
            manifest: { type: 'string' },
            instance: { type: 'string' },
        },
    });
    const corpus = await buildCorpus();
    if (values.manifest) {
        await mkdir(path.dirname(values.manifest), { recursive: true });
        const manifest = { ...corpus, items: corpus.items.map(({ text, ...item }) => ({ ...item, characters: text.length })) };
        await writeFile(values.manifest, JSON.stringify(manifest, null, 2) + '\n');
    }
    console.log(JSON.stringify({ instance: corpus.instance, hash: corpus.hash, counts: corpus.counts, index: corpus.index }, null, 2));
    if (values.check) return corpus;
    if (values.instance !== corpus.instance) {
        throw new Error(`Explicit --instance must match computed instance: ${corpus.instance}`);
    }
    await import('dotenv/config');
    const { accountId, apiToken } = requireCloudflareCredentials();
    const result = await ingestCorpus(createMaintenanceClient(apiToken), accountId, corpus, { instance: values.instance });
    console.log(JSON.stringify({ ...result, status: 'indexed (not activated)' }, null, 2));
    return result;
}

runIfMain(import.meta.url, main, 'Ingestion failed');
