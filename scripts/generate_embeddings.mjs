import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Cloudflare from 'cloudflare';
import { buildCorpus } from './lib/corpus.mjs';
import { ingestCorpus } from './lib/corpus-deployment.mjs';

export async function main(args = process.argv.slice(2)) {
    const { values } = parseArgs({
        args,
        options: {
            check: { type: 'boolean', default: false },
            manifest: { type: 'string' },
            namespace: { type: 'string' },
        },
    });
    const corpus = await buildCorpus();
    if (values.manifest) {
        await mkdir(path.dirname(values.manifest), { recursive: true });
        const manifest = {
            ...corpus,
            chunks: corpus.chunks.map(({ id, chunkIndex, metadata }) => {
                const { text, ...sourceMetadata } = metadata;
                return { id, chunkIndex, metadata: sourceMetadata };
            }),
        };
        await writeFile(values.manifest, JSON.stringify(manifest, null, 2) + '\n');
    }
    console.log(JSON.stringify({
        namespace: corpus.namespace, hash: corpus.hash, counts: corpus.counts,
        embedding: corpus.embedding, chunking: corpus.chunking,
    }, null, 2));
    if (values.check) return corpus;
    if (values.namespace !== corpus.namespace) {
        throw new Error(`Explicit --namespace must match computed namespace: ${corpus.namespace}`);
    }
    await import('dotenv/config');
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = process.env;
    if (!accountId || !apiToken) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
    const result = await ingestCorpus(new Cloudflare({ apiToken }), accountId, corpus, {
        namespace: values.namespace,
    });
    console.log(JSON.stringify({ ...result, status: 'accepted (asynchronous; not activated)' }, null, 2));
    return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`Embedding pipeline failed: ${error.message}`);
        process.exitCode = 1;
    });
}
