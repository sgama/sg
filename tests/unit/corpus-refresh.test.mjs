import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AI_CONFIG } from '../../functions/_lib/application.js';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { createMaintenanceClient, refreshCorpus, setCorpusNamespace, waitForMutation } from '../../scripts/lib/corpus-deployment.mjs';

const namespace = `corpus-${'a'.repeat(56)}`;
const config = '[ai]\nbinding = "AI"\n\n[vars]\nAI_MODEL = "glm"\n\n[[vectorize]]\nindex_name = "portfolio-index"\n';

test('namespace activation only changes the Wrangler vars section and preserves all bindings', () => {
    const updated = setCorpusNamespace(config, namespace);
    assert.equal(updated, config.replace('[vars]\n', `[vars]\nAI_CORPUS_NAMESPACE = "${namespace}"\n`));
    assert.equal(setCorpusNamespace(updated, namespace), updated);
    const next = `corpus-${'b'.repeat(56)}`;
    assert.ok(setCorpusNamespace(updated, next).includes(next));
    assert.throws(() => setCorpusNamespace(config, 'bad'), /Invalid corpus/);
    assert.throws(() => setCorpusNamespace('[ai]\nbinding = "AI"', namespace), /vars/);
    assert.throws(() => setCorpusNamespace(`[vars]\nAI_CORPUS_NAMESPACE = "a"\nAI_CORPUS_NAMESPACE = "b"\n`, namespace), /Duplicate/);
});

test('waits for processed mutation, rejects wrong dimensions and bounded timeout', async () => {
    let ticks = 0;
    let calls = 0;
    const client = { vectorize: { indexes: { info: async () => ({
        dimensions: AI_CONFIG.embedding.dimensions,
        processedUpToMutation: ++calls === 2 ? 'ready' : 'pending',
    }) } } };
    await waitForMutation(client, 'account', 'ready', {
        timeoutMs: 10, intervalMs: 1, clock: () => ticks, sleep: async () => { ticks++; },
    });
    assert.equal(calls, 2);
    client.vectorize.indexes.info = async () => ({ dimensions: 2 });
    await assert.rejects(waitForMutation(client, 'account', 'ready'), /dimensions/);
    client.vectorize.indexes.info = async () => ({ dimensions: AI_CONFIG.embedding.dimensions });
    ticks = 0;
    await assert.rejects(waitForMutation(client, 'account', 'ready', {
        timeoutMs: 2, clock: () => ticks, sleep: async () => { ticks++; },
    }), /Timed out/);
    client.vectorize.indexes.info = async () => { throw new Error('info unavailable'); };
    await assert.rejects(waitForMutation(client, 'account', 'ready'), /info unavailable/);
});

test('mutation deadline rejects a stalled request and aborts its signal', async () => {
    let signal;
    const client = { vectorize: { indexes: { info: async (_, __, options) => {
        signal = options.signal;
        return new Promise(() => {});
    } } } };
    await Promise.all([
        assert.rejects(waitForMutation(client, 'account', 'stalled', { timeoutMs: 20 }), /Timed out/),
        delay(40),
    ]);
    assert.equal(signal.aborted, true);
});

test('mutation deadline interrupts polling sleep instead of waiting for the interval', async () => {
    let calls = 0;
    const client = { vectorize: { indexes: { info: async () => {
        calls++;
        return { dimensions: AI_CONFIG.embedding.dimensions, processedUpToMutation: 'pending' };
    } } } };
    await assert.rejects(waitForMutation(client, 'account', 'stalled',
        { timeoutMs: 20, intervalMs: 60000 }), /Timed out/);
    assert.equal(calls, 1);
});

test('mutation deadline bounds SDK retry backoff and prevents another fetch', async (t) => {
    let retry;
    const setTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
        if (ms !== 120000) return setTimeout(callback, ms, ...args);
        retry = () => callback(...args);
        return setTimeout(() => {}, 0);
    });
    let calls = 0;
    const client = createMaintenanceClient('test-token', async () => {
        calls++;
        return Response.json({ success: false }, { status: 504, headers: { 'retry-after': '120' } });
    });
    await Promise.all([
        assert.rejects(waitForMutation(client, 'account', 'stalled', { timeoutMs: 100 }), /Timed out/),
        delay(150),
    ]);
    assert.equal(typeof retry, 'function');
    retry();
    await delay(0);
    assert.equal(calls, 1);
});

async function refreshFixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-corpus-refresh-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'content'));
    await fs.writeFile(path.join(root, 'content/page.md'), '---\ntitle: Test\n---\nCurrent content.');
    const configPath = path.join(root, 'wrangler.toml');
    await fs.writeFile(configPath, config);
    const calls = [];
    const client = {
        pages: { projects: { get: async () => ({ canonical_deployment: null }) } },
        ai: { run: async () => ({ data: [Array(AI_CONFIG.embedding.dimensions).fill(0.1)] }) },
        vectorize: { indexes: { upsert: async () => {
            calls.push('upsert');
            return { mutationId: 'accepted' };
        } } },
    };
    const wait = async (passedClient, accountId, mutationId) => {
        assert.equal(passedClient, client);
        assert.equal(accountId, 'account');
        assert.equal(mutationId, 'accepted');
        assert.equal(await fs.readFile(configPath, 'utf8'), config);
        calls.push('ready');
    };
    return { root, configPath, client, calls, wait, accountId: 'account' };
}

test('refresh activates only after successful ingestion and readiness', async (t) => {
    const { root, configPath, client, calls, wait } = await refreshFixture(t);
    const result = await refreshCorpus({ client, accountId: 'account', root, wait });
    assert.deepEqual(calls, ['upsert', 'ready']);
    assert.ok((await fs.readFile(configPath, 'utf8')).includes(result.namespace));
});

test('indexing failures leave configuration untouched', async (t) => {
    const { root, configPath, client } = await refreshFixture(t);
    await assert.rejects(refreshCorpus({ client, accountId: 'account', root,
        wait: async () => { throw new Error('not ready'); } }), /not ready/);
    assert.equal(await fs.readFile(configPath, 'utf8'), config);
});

test('embedding failures leave configuration untouched', async (t) => {
    const { root, configPath, client, wait } = await refreshFixture(t);
    client.ai.run = async () => { throw new Error('embedding failed'); };
    await assert.rejects(refreshCorpus({ client, accountId: 'account', root, wait }), /embedding failed/);
    assert.equal(await fs.readFile(configPath, 'utf8'), config);
});

test('unchanged corpus skips all embeddings, uploads and readiness waits but sets namespace', async (t) => {
    const { root, configPath, client } = await refreshFixture(t);
    client.ai.run = async () => { assert.fail('Unexpected embedding request'); };
    client.vectorize.indexes.upsert = async () => { assert.fail('Unexpected upload'); };
    const corpus = await buildCorpus({ root });
    const snapshot = { id: 'active', environment: 'production',
        env_vars: { AI_CORPUS_NAMESPACE: { type: 'plain_text', value: corpus.namespace } } };
    client.pages.projects.get = async () => ({ canonical_deployment: { id: 'active' } });
    client.pages.projects.deployments = { get: async () => snapshot };
    const reused = await refreshCorpus({ client, accountId: 'account', root,
        wait: async () => { assert.fail('Unchanged corpus must not wait for ingestion'); } });
    assert.equal(reused.skipped, true);
    assert.deepEqual(reused.mutationIds, []);
    assert.ok((await fs.readFile(configPath, 'utf8')).includes(corpus.namespace));
});

test('SDK transport retrieves the active deployment snapshot using the SDK 7 signature', async (t) => {
    const { root, configPath } = await refreshFixture(t);
    const corpus = await buildCorpus({ root });
    const requests = [];
    const client = createMaintenanceClient('test-token', async (url) => {
        const pathname = new URL(url).pathname;
        requests.push(pathname);
        const base = '/client/v4/accounts/account/pages/projects/sg';
        assert.ok([base, `${base}/deployments/active`].includes(pathname));
        return Response.json({ success: true, result: pathname === base
            ? { canonical_deployment: { id: 'active' } }
            : { id: 'active', environment: 'production',
                env_vars: { AI_CORPUS_NAMESPACE: { type: 'plain_text', value: corpus.namespace } } } });
    });
    const result = await refreshCorpus({ client, accountId: 'account', root });
    assert.equal(result.skipped, true);
    assert.equal(requests.length, 2);
    assert.ok((await fs.readFile(configPath, 'utf8')).includes(corpus.namespace));
});

test('changed corpus requires ingestion', async (t) => {
    const { root, configPath, client, wait } = await refreshFixture(t);
    client.pages.projects.get = async () => ({ canonical_deployment: { id: 'active' } });
    client.pages.projects.deployments = { get: async () => ({ id: 'active', environment: 'production',
        env_vars: { AI_CORPUS_NAMESPACE: { type: 'plain_text', value: namespace } } }) };
    client.ai.run = async () => { throw new Error('embedding failed'); };
    await assert.rejects(refreshCorpus({ client, accountId: 'account', root, wait }), /embedding failed/);
    assert.equal(await fs.readFile(configPath, 'utf8'), config);
});

test('invalid active namespace stops refresh without changing configuration', async (t) => {
    const { root, configPath, client, wait } = await refreshFixture(t);
    client.pages.projects.get = async () => ({ canonical_deployment: { id: 'active' } });
    client.pages.projects.deployments = { get: async () => ({ id: 'active', environment: 'production',
        env_vars: { AI_CORPUS_NAMESPACE: { type: 'plain_text', value: 'invalid' } } }) };
    await assert.rejects(refreshCorpus({ client, accountId: 'account', root, wait }), /Invalid active corpus namespace/);
    assert.equal(await fs.readFile(configPath, 'utf8'), config);
});

test('Pages lookup failures leave configuration untouched', async (t) => {
    const { root, configPath, client, wait } = await refreshFixture(t);
    client.pages.projects.get = async () => { throw new Error('Pages unavailable'); };
    await assert.rejects(refreshCorpus({ client, accountId: 'account', root, wait }), /Pages unavailable/);
    assert.equal(await fs.readFile(configPath, 'utf8'), config);
});

test('force refresh ingests even when Pages lookup is unavailable', async (t) => {
    const { root, client, wait, calls } = await refreshFixture(t);
    client.pages.projects.get = async () => { throw new Error('Pages unavailable'); };
    const forced = await refreshCorpus({ client, accountId: 'account', root, wait, force: true });
    assert.equal(forced.skipped, false);
    assert.deepEqual(calls, ['upsert', 'ready']);
});
