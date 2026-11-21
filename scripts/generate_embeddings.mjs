import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildCorpus } from './lib/corpus.mjs';
import { requireCloudflareCredentials } from './lib/cloudflare-ai.mjs';
import { createMaintenanceClient, ingestCorpus, waitForMutation } from './lib/corpus-deployment.mjs';
import { runIfMain } from './lib/cli.mjs';

export async function main(args = process.argv.slice(2)) {
    const { values } = parseArgs({
        args,
        options: {
            check: { type: 'boolean', default: false },
            manifest: { type: 'string' },
            namespace: { type: 'string' },
            'previous-namespace': { type: 'string' },
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
    console.log(
        JSON.stringify(
            {
                namespace: corpus.namespace,
                hash: corpus.hash,
                counts: corpus.counts,
                embedding: corpus.embedding,
                chunking: corpus.chunking,
            },
            null,
            2,
        ),
    );
    if (values.check) return corpus;
    if (values.namespace !== corpus.namespace) {
        throw new Error(`Explicit --namespace must match computed namespace: ${corpus.namespace}`);
    }
    await import('dotenv/config');
    const { accountId, apiToken } = requireCloudflareCredentials();
    const client = createMaintenanceClient(apiToken);
    const result = await ingestCorpus(client, accountId, corpus, {
        namespace: values.namespace,
        previousNamespace: values['previous-namespace'],
    });
    // Mutations apply in order, so the last one processed means the whole namespace is queryable.
    if (result.mutationIds.length) await waitForMutation(client, accountId, result.mutationIds.at(-1));
    console.log(JSON.stringify({ ...result, status: 'processed (not activated)' }, null, 2));
    return result;
}

runIfMain(import.meta.url, main, 'Embedding pipeline failed');
