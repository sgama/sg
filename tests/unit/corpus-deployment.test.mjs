import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { createMaintenanceClient, ingestCorpus, waitForItems } from '../../scripts/lib/corpus-deployment.mjs';
import { aiSearchMock } from '../helpers/ai-search.mjs';
import { corpusFixture as fixture } from '../helpers/corpus.mjs';

const fast = { intervalMs: 1, timeoutMs: 2000 };

test('a failed upload aborts the remaining uploads and is never retried', async (t) => {
    const corpus = await buildCorpus({
        root: await fixture(t, Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`content/page-${index}.md`, `Body ${index}.`]))),
    });
    const mock = aiSearchMock({ failUploadKey: corpus.items[1].key });
    const client = createMaintenanceClient('token', mock.fetchImpl);
    await assert.rejects(ingestCorpus(client, 'account', corpus, { instance: corpus.instance, concurrency: 1, ...fast }), /400|boom/);
    assert.equal(mock.uploads.length, 1);
    assert.equal(mock.requests.filter(({ method, pathname }) => method === 'POST' && pathname.endsWith('/items')).length, 2);
});

test('ingestion creates the instance with the documented settings and uploads one file per item', async (t) => {
    const corpus = await buildCorpus({ root: await fixture(t) });
    const mock = aiSearchMock();
    mock.pollsUntilDone = 2;
    const result = await ingestCorpus(createMaintenanceClient('token', mock.fetchImpl), 'account', corpus, {
        instance: corpus.instance,
        gatewayId: 'gateway',
        ...fast,
    });
    assert.deepEqual(result, { instance: corpus.instance, count: 3, uploaded: 3, reused: 0 });
    const { config } = mock.store.get(corpus.instance);
    assert.deepEqual(config, {
        id: corpus.instance,
        index_method: { vector: true, keyword: true },
        fusion_method: 'rrf',
        reranking: true,
        chunk: true,
        cache: true,
        custom_metadata: [
            { field_name: 'title', data_type: 'text' },
            { field_name: 'url', data_type: 'text' },
        ],
        embedding_model: corpus.index.embeddingModel,
        reranking_model: corpus.index.reranker,
        chunk_size: corpus.index.chunkSize,
        chunk_overlap: corpus.index.chunkOverlap,
        ai_gateway_id: 'gateway',
    });
    assert.deepEqual(
        mock.uploads.map(({ key, metadata, text }) => ({ key, metadata, text })).sort((a, b) => a.key.localeCompare(b.key)),
        corpus.items.map(({ key, metadata, text }) => ({ key, metadata, text })),
    );
    assert.ok(mock.requests.every(({ pathname }) => !pathname.includes('vectorize')));
});

test('ingestion resumes an existing instance without uploading completed items again', async (t) => {
    const corpus = await buildCorpus({ root: await fixture(t) });
    const [done, ...rest] = corpus.items;
    const mock = aiSearchMock({ instances: { [corpus.instance]: [done.key] } });
    const client = createMaintenanceClient('token', mock.fetchImpl);
    const result = await ingestCorpus(client, 'account', corpus, { instance: corpus.instance, ...fast });
    assert.deepEqual(result, { instance: corpus.instance, count: 3, uploaded: 2, reused: 1 });
    assert.deepEqual(mock.uploads.map(({ key }) => key).sort(), rest.map(({ key }) => key).sort());
    assert.ok(
        !mock.requests.some(({ method, pathname }) => method === 'POST' && !pathname.endsWith('/items')),
        'an existing instance is not recreated',
    );
    const forced = await ingestCorpus(client, 'account', corpus, { instance: corpus.instance, force: true, ...fast });
    assert.equal(forced.uploaded, 3);
});

test('ingestion validates the instance, corpus and parameters before any request', async (t) => {
    const corpus = await buildCorpus({ root: await fixture(t) });
    const mock = aiSearchMock();
    const client = createMaintenanceClient('token', mock.fetchImpl);
    await assert.rejects(ingestCorpus(client, 'account', corpus), /instance/);
    await assert.rejects(ingestCorpus(client, 'account', corpus, { instance: 'portfolio-000000000000' }), /instance/);
    const tampered = structuredClone(corpus);
    tampered.items[0].text = 'altered';
    await assert.rejects(ingestCorpus(client, 'account', tampered, { instance: corpus.instance }), /hash/);
    for (const concurrency of [0, 6, 1.5]) {
        await assert.rejects(ingestCorpus(client, 'account', corpus, { instance: corpus.instance, concurrency }), /Concurrency/);
    }
    await assert.rejects(ingestCorpus(client, '', corpus, { instance: corpus.instance }), /Account ID/);
    const empty = await buildCorpus({ root: await fixture(t, { 'content/page.md': '' }) });
    await assert.rejects(ingestCorpus(client, 'account', empty, { instance: empty.instance }), /empty corpus/);
    assert.equal(mock.requests.length, 0);
});

test('polling rejects errored or skipped items, unexpected items and timeouts', async (t) => {
    const corpus = await buildCorpus({ root: await fixture(t) });
    const keys = corpus.items.map((item) => item.key);
    for (const [status, expected] of [
        ['error', /error/],
        ['skipped', /skipped/],
    ]) {
        const mock = aiSearchMock({ instances: { [corpus.instance]: keys } });
        mock.store.get(corpus.instance).items.get(keys[0]).status = status;
        await assert.rejects(
            waitForItems(createMaintenanceClient('token', mock.fetchImpl), 'account', corpus, { instance: corpus.instance, ...fast }),
            expected,
        );
    }
    const extra = aiSearchMock({ instances: { [corpus.instance]: [...keys, 'content/unexpected.md'] } });
    await assert.rejects(
        waitForItems(createMaintenanceClient('token', extra.fetchImpl), 'account', corpus, { instance: corpus.instance, ...fast }),
        /unexpected items/,
    );
    const missing = aiSearchMock();
    await assert.rejects(
        waitForItems(createMaintenanceClient('token', missing.fetchImpl), 'account', corpus, { instance: corpus.instance, ...fast }),
        /does not exist/,
    );
    const stuck = aiSearchMock({ instances: { [corpus.instance]: keys } });
    stuck.store.get(corpus.instance).items.get(keys[0]).status = 'running';
    await assert.rejects(
        waitForItems(createMaintenanceClient('token', stuck.fetchImpl), 'account', corpus, {
            instance: corpus.instance,
            intervalMs: 5,
            timeoutMs: 50,
        }),
        /Timed out/,
    );
});
