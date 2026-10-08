import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import Cloudflare from 'cloudflare';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { createMaintenanceClient, ingestCorpus } from '../../scripts/lib/corpus-deployment.mjs';
import { corpusFixture as fixture, integrityFixture } from '../helpers/corpus.mjs';

test('embedding and upsert errors and unaccepted mutations are never swallowed', async (t) => {
    const corpus = await buildCorpus({ root: await fixture(t) });
    const options = { namespace: corpus.namespace, concurrency: 1 };
    for (const data of [[[0.1]], [Array(corpus.embedding.dimensions).fill(NaN)], []]) {
        const client = clientStub(corpus.embedding.dimensions);
        client.post = async () => ({ result: { data } });
        await assert.rejects(ingestCorpus(client, 'account', corpus, options), /Invalid embedding/);
        assert.equal(client.calls.upserts.length, 0);
    }
    const failedEmbedding = clientStub(corpus.embedding.dimensions);
    failedEmbedding.post = async () => {
        throw new Error('embedding unavailable');
    };
    await assert.rejects(ingestCorpus(failedEmbedding, 'account', corpus, options), /embedding unavailable/);
    assert.equal(failedEmbedding.calls.upserts.length, 0);
    const failedUpsert = clientStub(corpus.embedding.dimensions);
    failedUpsert.vectorize.indexes.upsert = async () => {
        throw new Error('upsert unavailable');
    };
    await assert.rejects(ingestCorpus(failedUpsert, 'account', corpus, options), /upsert unavailable/);
    for (const response of [null, {}, { mutationId: '' }]) {
        const client = clientStub(corpus.embedding.dimensions);
        client.vectorize.indexes.upsert = async () => response;
        await assert.rejects(ingestCorpus(client, 'account', corpus, options), /not accepted/);
    }
});

test('first embedding failure aborts in-flight work and prevents queued inference and uploads', async (t) => {
    const corpus = await buildCorpus({
        root: await fixture(t, Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`content/page-${index}.md`, `Body ${index}.`]))),
    });
    const failure = new Error('embedding unavailable');
    let calls = 0;
    let fail;
    let inFlightAborted = false;
    const client = clientStub(corpus.embedding.dimensions);
    client.post = async (_, { signal, maxRetries }) => {
        assert.equal(maxRetries, 0);
        calls++;
        if (calls === 1)
            return new Promise((_, reject) => {
                fail = () => reject(failure);
            });
        return new Promise((_, reject) => {
            signal.addEventListener(
                'abort',
                () => {
                    inFlightAborted = true;
                    reject(signal.reason);
                },
                { once: true },
            );
            fail();
        });
    };
    await assert.rejects(ingestCorpus(client, 'account', corpus, { namespace: corpus.namespace, concurrency: 2 }), (error) => error === failure);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(inFlightAborted, true);
    assert.equal(client.calls.upserts.length, 0);
});

test('ingestion requires exact namespace and rejects duplicate/tampered IDs before requests', async (t) => {
    const corpus = await buildCorpus({ root: await fixture(t) });
    const client = clientStub(corpus.embedding.dimensions);
    await assert.rejects(ingestCorpus(client, 'account', corpus), /namespace/);
    await assert.rejects(ingestCorpus(client, 'account', corpus, { namespace: 'legacy' }), /namespace/);
    const duplicate = structuredClone(corpus);
    duplicate.chunks[1].id = duplicate.chunks[0].id;
    await assert.rejects(ingestCorpus(client, 'account', duplicate, { namespace: corpus.namespace }), /Duplicate/);
    const tampered = structuredClone(corpus);
    tampered.chunks[0].text = 'altered';
    await assert.rejects(ingestCorpus(client, 'account', tampered, { namespace: corpus.namespace }), /hash/);
    assert.equal(client.calls.embeddings.length, 0);
    assert.equal(client.calls.upserts.length, 0);
});

test('ingestion uploads namespaced NDJSON files deterministically and reports accepted mutations', async (t) => {
    const corpus = await buildCorpus({ root: await fixture(t) });
    const client = clientStub(corpus.embedding.dimensions);
    const result = await ingestCorpus(client, 'account', corpus, {
        namespace: corpus.namespace,
        batchSize: 2,
    });
    assert.deepEqual(result, {
        namespace: corpus.namespace,
        count: 3,
        mutationIds: ['mutation-1', 'mutation-2'],
    });
    const vectors = client.calls.upserts.flatMap((call) => call.vectors);
    assert.deepEqual(
        vectors.map((vector) => vector.id),
        corpus.chunks.map((chunk) => chunk.id),
    );
    assert.ok(vectors.every((vector) => vector.namespace === corpus.namespace));
    assert.ok(client.calls.upserts.every((call) => call.params['unparsable-behavior'] === 'error' && call.params.account_id === 'account'));
    assert.ok(client.calls.embeddings.every((call) => call.model === corpus.embedding.model));
});

test('invalid ingestion parameters and empty corpora never call upstream services', async (t) => {
    const { root, corpus } = await integrityFixture(t);
    const client = {};
    for (const options of [{ concurrency: 0 }, { concurrency: 6 }, { batchSize: 0 }, { batchSize: 1001 }, { indexName: '' }]) {
        await assert.rejects(ingestCorpus(client, 'account', corpus, { namespace: corpus.namespace, ...options }), /Concurrency|Account ID/);
    }
    await assert.rejects(ingestCorpus(client, '', corpus, { namespace: corpus.namespace }), /Account ID/);
    await writeFile(path.join(root, 'content/page.md'), '');
    const empty = await buildCorpus({ root });
    await assert.rejects(ingestCorpus(client, 'account', empty, { namespace: empty.namespace }), /empty corpus/);
});

test('maintenance retry defaults do not retry paid embedding failures', async (t) => {
    const corpus = await buildCorpus({
        root: await fixture(t, { 'content/page.md': 'Body.' }),
        embedding: { model: '@cf/test/model', dimensions: 2 },
    });
    let calls = 0;
    const client = createMaintenanceClient('test-token', async (url) => {
        calls++;
        assert.match(String(url), /\/ai\/run\/@cf\/test\/model$/);
        return Response.json({ success: false, errors: [{ message: 'embedding unavailable' }] }, { status: 504 });
    });
    await assert.rejects(
        ingestCorpus(client, 'account', corpus, { namespace: corpus.namespace }),
        (error) => error instanceof Cloudflare.APIError && error.status === 504,
    );
    assert.equal(calls, 1);
});

test('SDK transport sends uploaded NDJSON bytes, not a JSON file wrapper (mock fetch only)', async (t) => {
    const corpus = await buildCorpus({
        root: await fixture(t, { 'content/page.md': 'Body.' }),
        embedding: { model: '@cf/test/model', dimensions: 2 },
    });
    const requests = [];
    const client = new Cloudflare({
        apiToken: 'test-token',
        maxRetries: 0,
        fetch: async (url, init) => {
            requests.push(new Request(url, init));
            return new Response(
                JSON.stringify({
                    success: true,
                    errors: [],
                    result: String(url).includes('/ai/run/') ? { data: [[0.1, 0.2]] } : { mutationId: 'mock-mutation' },
                }),
                { headers: { 'content-type': 'application/json' } },
            );
        },
    });
    await ingestCorpus(client, 'account', corpus, { namespace: corpus.namespace });
    assert.equal(new URL(requests[0].url).pathname, '/client/v4/accounts/account/ai/run/@cf/test/model');
    const request = requests.find(({ url }) => url.includes('/upsert'));
    assert.match(request.url, /unparsable-behavior=error/);
    assert.equal(request.headers.get('content-type'), 'application/x-ndjson');
    const vector = JSON.parse((await request.text()).trim());
    assert.equal(vector.namespace, corpus.namespace);
    assert.deepEqual(vector.values, [0.1, 0.2]);
});

function clientStub(dimensions) {
    const calls = { embeddings: [], upserts: [] };
    return {
        calls,
        post: async (url, { body }) => {
            calls.embeddings.push({ model: url.split('/ai/run/')[1], body });
            return { result: { data: [Array(dimensions).fill(0.1)] } };
        },
        vectorize: {
            indexes: {
                upsert: async (index, params) => {
                    calls.upserts.push({
                        index,
                        params,
                        vectors: (await params.body.text()).trim().split('\n').map(JSON.parse),
                    });
                    return { mutationId: `mutation-${calls.upserts.length}` };
                },
            },
        },
    };
}
