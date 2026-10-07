import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Cloudflare from 'cloudflare';
import 'dotenv/config';
import { AI_CONFIG } from '../functions/_lib/ai-config.js';
import { buildCorpus, ingestCorpus } from './generate_embeddings.mjs';

export function setCorpusNamespace(config, namespace) {
    if (!/^corpus-[a-f0-9]{56}$/.test(namespace)) throw new Error('Invalid corpus namespace');
    const sections = config.split(/(^\[[^\r\n]+\][ \t]*\r?$)/m);
    const index = sections.findIndex(section => section === '[vars]');
    if (index === -1 || index + 1 >= sections.length) throw new Error('Wrangler [vars] section is required');
    const entries = sections[index + 1].match(/^AI_CORPUS_NAMESPACE\s*=.*$/gm) ?? [];
    if (entries.length > 1) throw new Error('Duplicate AI_CORPUS_NAMESPACE settings');
    const setting = `AI_CORPUS_NAMESPACE = "${namespace}"`;
    sections[index + 1] = entries.length
        ? sections[index + 1].replace(/^AI_CORPUS_NAMESPACE\s*=.*$/m, setting)
        : `\n${setting}${sections[index + 1]}`;
    return sections.join('');
}

export async function waitForMutation(client, accountId, mutationId, {
    indexName = AI_CONFIG.retrieval.indexName,
    timeoutMs = 180000,
    intervalMs = 2000,
    clock = () => performance.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    const start = clock();
    while (clock() - start < timeoutMs) {
        const info = await client.vectorize.indexes.info(indexName, { account_id: accountId });
        if (info?.dimensions !== AI_CONFIG.embedding.dimensions) throw new Error('Vectorize index dimensions do not match embedding configuration');
        if (info.processedUpToMutation === mutationId) return;
        await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for Vectorize mutation ${mutationId}; corpus was not activated`);
}

export async function refreshCorpus({
    client, accountId, root = process.cwd(),
    configPath = path.join(root, 'wrangler.toml'),
    wait = waitForMutation,
}) {
    const original = await readFile(configPath, 'utf8');
    const corpus = await buildCorpus({ root });
    const updated = setCorpusNamespace(original, corpus.namespace);
    // Process one upload batch at a time so no later batch can hide its readiness marker.
    const result = await ingestCorpus(client, accountId, corpus, {
        namespace: corpus.namespace,
        afterMutation: mutationId => wait(client, accountId, mutationId),
    });
    if (await readFile(configPath, 'utf8') !== original) {
        throw new Error('Wrangler configuration changed during ingestion; refusing to overwrite');
    }
    await writeFile(configPath, updated);
    return result;
}

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
