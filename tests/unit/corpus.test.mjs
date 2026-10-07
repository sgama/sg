import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import Cloudflare from 'cloudflare';
import { buildCorpus, ingestCorpus } from '../../scripts/generate_embeddings.mjs';

let fixtureIndex = 0;
async function fixture(t, files = {
    'content/posts/first/index.md': '---\ntitle: First\n---\nFirst source body.',
    'content/posts/second/index.md': '---\ntitle: Second\n---\nSecond source body.',
    'content/_context/private.md': '---\ntitle: Internal\n---\nInternal context.',
    'content/draft.md': '---\ndraft: true\n---\nNot included.',
    'content/empty.md': '---\ntitle: Empty\n---\n',
}) {
    const root = path.resolve(`tests/fixtures/corpus-${process.pid}-${fixtureIndex++}`);
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await writeFile(path.join(root, name), text);
    }
    return root;
}

function clientStub(dimensions) {
    const calls = { embeddings: [], upserts: [] };
    return {
        calls,
        ai: {
            run: async (model, body) => {
                calls.embeddings.push({ model, body });
                return { data: [Array(dimensions).fill(0.1)] };
            },
        },
        vectorize: {
            indexes: {
                upsert: async (index, params) => {
                    calls.upserts.push({
                        index, params,
                        vectors: (await params.body.text()).trim().split('\n').map(JSON.parse),
                    });
                    return { mutationId: `mutation-${calls.upserts.length}` };
                },
            },
        },
    };
}

test('corpus IDs distinguish full source paths and chunk indices; canonical metadata', async (t) => {
    const root = await fixture(t);
    const corpus = await buildCorpus({ root });
    assert.deepEqual(corpus.counts, {
        files: 5, includedFiles: 3, draftFiles: 1, emptyFiles: 1, chunks: 3,
    });
    assert.equal(new Set(corpus.chunks.map((chunk) => chunk.id)).size, 3);
    assert.ok(corpus.chunks.every((chunk) => chunk.id.length === 64));
    assert.match(corpus.namespace, /^corpus-[a-f0-9]{56}$/);
    assert.deepEqual(corpus.sources.map(({ source }) => source),
        corpus.sources.map(({ source }) => source).sort());
    const internal = corpus.chunks.find((chunk) => chunk.metadata.type === 'context');
    assert.equal(internal.metadata.source, 'content/_context/private.md');
    assert.ok(!Object.hasOwn(internal.metadata, 'url'));
    const publicChunk = corpus.chunks.find((chunk) => chunk.metadata.title === 'First');
    assert.equal(publicChunk.metadata.url, '/posts/first');
    assert.equal(publicChunk.text, publicChunk.metadata.text);
    await writeFile(path.join(root, 'content/posts/first/index.md'), 'First paragraph.\n\nSecond paragraph.');
    const split = await buildCorpus({ root, chunking: { chunkSize: 20, chunkOverlap: 2 } });
    const firstChunks = split.chunks.filter((chunk) => chunk.metadata.source === publicChunk.metadata.source);
    assert.ok(firstChunks.length > 1);
    assert.equal(new Set(firstChunks.map((chunk) => chunk.id)).size, firstChunks.length);
});

test('hash and IDs repeat deterministically and change with corpus or embedding/chunk configuration', async (t) => {
    const root = await fixture(t);
    const original = await buildCorpus({ root });
    assert.deepEqual(await buildCorpus({ root }), original);
    for (const options of [
        { embedding: { ...original.embedding, model: 'different-model' } },
        { embedding: { ...original.embedding, dimensions: 3 } },
        { chunking: { chunkSize: 1000, chunkOverlap: 100 } },
    ]) {
        const changed = await buildCorpus({ root, ...options });
        assert.notEqual(changed.hash, original.hash);
        assert.notEqual(changed.namespace, original.namespace);
        assert.notEqual(changed.chunks[0].id, original.chunks[0].id);
    }
    await writeFile(path.join(root, 'content/_context/private.md'), 'Changed context.');
    assert.notEqual((await buildCorpus({ root })).namespace, original.namespace);
});

test('file parsing errors reject rather than silently skipping files', async (t) => {
    const root = await fixture(t, { 'content/bad.md': '---\ntitle: [invalid\n---\nBody' });
    await assert.rejects(buildCorpus({ root }));
});

test('ingestion requires exact namespace and rejects duplicate/tampered IDs before requests', async (t) => {
    const corpus = await buildCorpus({ root: await fixture(t) });
    const client = clientStub(corpus.embedding.dimensions);
    await assert.rejects(ingestCorpus(client, 'account', corpus), /namespace/);
    await assert.rejects(ingestCorpus(client, 'account', corpus, { namespace: 'legacy' }), /namespace/);
    const duplicate = structuredClone(corpus);
    duplicate.chunks[1].id = duplicate.chunks[0].id;
    await assert.rejects(ingestCorpus(client, 'account', duplicate,
        { namespace: corpus.namespace }), /Duplicate/);
    const tampered = structuredClone(corpus);
    tampered.chunks[0].text = 'altered';
    await assert.rejects(ingestCorpus(client, 'account', tampered,
        { namespace: corpus.namespace }), /hash/);
    assert.equal(client.calls.embeddings.length, 0);
    assert.equal(client.calls.upserts.length, 0);
});

test('ingestion uploads namespaced NDJSON files deterministically and reports accepted mutations', async (t) => {
    const corpus = await buildCorpus({ root: await fixture(t) });
    const client = clientStub(corpus.embedding.dimensions);
    const result = await ingestCorpus(client, 'account', corpus,
        { namespace: corpus.namespace, batchSize: 2 });
    assert.deepEqual(result, {
        namespace: corpus.namespace, count: 3, mutationIds: ['mutation-1', 'mutation-2'],
    });
    const vectors = client.calls.upserts.flatMap((call) => call.vectors);
    assert.deepEqual(vectors.map((vector) => vector.id), corpus.chunks.map((chunk) => chunk.id));
    assert.ok(vectors.every((vector) => vector.namespace === corpus.namespace));
    assert.ok(client.calls.upserts.every((call) =>
        call.params['unparsable-behavior'] === 'error' && call.params.account_id === 'account'));
    assert.ok(client.calls.embeddings.every((call) => call.model === corpus.embedding.model));
});

test('SDK transport sends uploaded NDJSON bytes, not a JSON file wrapper (mock fetch only)', async (t) => {
    const corpus = await buildCorpus({
        root: await fixture(t, { 'content/page.md': 'Body.' }),
        embedding: { model: 'test-model', dimensions: 2 },
    });
    const requests = [];
    const client = new Cloudflare({
        apiToken: 'test-token', maxRetries: 0,
        fetch: async (url, init) => {
            requests.push({ url: String(url), init });
            return new Response(JSON.stringify({ success: true, errors: [],
                result: String(url).includes('/ai/run/')
                    ? { data: [[0.1, 0.2]] } : { mutationId: 'mock-mutation' },
            }), { headers: { 'content-type': 'application/json' } });
        },
    });
    await ingestCorpus(client, 'account', corpus, { namespace: corpus.namespace });
    const request = requests.find(({ url }) => url.includes('/upsert'));
    assert.match(request.url, /unparsable-behavior=error/);
    assert.equal(request.init.headers['content-type'], 'application/x-ndjson');
    const vector = JSON.parse(new TextDecoder().decode(request.init.body).trim());
    assert.equal(vector.namespace, corpus.namespace);
    assert.deepEqual(vector.values, [0.1, 0.2]);
});

test('embedding and upsert errors and unaccepted mutations are never swallowed', async (t) => {
    const corpus = await buildCorpus({ root: await fixture(t) });
    const options = { namespace: corpus.namespace, concurrency: 1 };
    for (const data of [[[0.1]], [Array(corpus.embedding.dimensions).fill(NaN)], []]) {
        const client = clientStub(corpus.embedding.dimensions);
        client.ai.run = async () => ({ data });
        await assert.rejects(ingestCorpus(client, 'account', corpus, options), /Invalid embedding/);
        assert.equal(client.calls.upserts.length, 0);
    }
    const failedEmbedding = clientStub(corpus.embedding.dimensions);
    failedEmbedding.ai.run = async () => { throw new Error('embedding unavailable'); };
    await assert.rejects(ingestCorpus(failedEmbedding, 'account', corpus, options), /embedding unavailable/);
    assert.equal(failedEmbedding.calls.upserts.length, 0);
    const failedUpsert = clientStub(corpus.embedding.dimensions);
    failedUpsert.vectorize.indexes.upsert = async () => { throw new Error('upsert unavailable'); };
    await assert.rejects(ingestCorpus(failedUpsert, 'account', corpus, options), /upsert unavailable/);
    for (const response of [null, {}, { mutationId: '' }]) {
        const client = clientStub(corpus.embedding.dimensions);
        client.vectorize.indexes.upsert = async () => response;
        await assert.rejects(ingestCorpus(client, 'account', corpus, options), /not accepted/);
    }
});

test('offline CLI needs no credentials, writes reproducible manifest, and import is side-effect safe', async (t) => {
    const root = await fixture(t);
    const manifest = path.join(root, 'manifest.json');
    const script = path.resolve('scripts/generate_embeddings.mjs');
    const env = { ...process.env };
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.CLOUDFLARE_API_TOKEN;
    const result = spawnSync(process.execPath, [script, '--check', '--manifest', manifest],
        { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).namespace, (await buildCorpus({ root })).namespace);
    const { readFile } = await import('node:fs/promises');
    const saved = JSON.parse(await readFile(manifest, 'utf8'));
    const corpus = await buildCorpus({ root });
    assert.equal(saved.namespace, corpus.namespace);
    assert.equal(saved.hash, corpus.hash);
    assert.deepEqual(saved.embedding, corpus.embedding);
    assert.deepEqual(saved.counts, corpus.counts);
    assert.deepEqual(saved.sources, corpus.sources);
    assert.deepEqual(saved.chunks.map(({ id }) => id), corpus.chunks.map(({ id }) => id));
    assert.ok(saved.chunks.every((chunk) =>
        !Object.hasOwn(chunk, 'text') && !Object.hasOwn(chunk.metadata, 'text')));
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
        `await import(${JSON.stringify(new URL('../../scripts/generate_embeddings.mjs', import.meta.url).href)})`],
        { env, encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
    const rejected = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /--namespace/);
});
