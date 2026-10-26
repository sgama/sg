import { integrityFixture } from '../helpers/corpus.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AI_CONFIG } from '../../functions/_lib/application.js';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { createMaintenanceClient, refreshCorpus, setCorpusNamespace } from '../../scripts/lib/corpus-deployment.mjs';

const namespace = `corpus-${'a'.repeat(56)}`;
/** A stubbed `client.workers`: the live Worker's corpus namespace, or a 404 (not deployed) when undefined. */
const live = (value) => ({
    scripts: {
        scriptAndVersionSettings: {
            get: async () => {
                if (value === undefined) throw Object.assign(new Error('Worker not found'), { status: 404 });
                return { bindings: [{ type: 'plain_text', name: 'AI_CORPUS_NAMESPACE', text: value }] };
            },
        },
    },
});
const config = '[ai]\nbinding = "AI"\n\n[vars]\nAI_MODEL = "glm"\n\n[[vectorize]]\nindex_name = "portfolio-index"\n';

test('force refresh ingests even when the Worker lookup is unavailable', async (t) => {
    const { root, configPath, client, wait, calls } = await refreshFixture(t);
    client.workers.scripts.scriptAndVersionSettings.get = async () => {
        throw new Error('Worker settings unavailable');
    };
    const forced = await refreshCorpus({ client, accountId: 'account', root, wait, force: true });
    assert.equal(forced.skipped, false);
    assert.deepEqual(calls, ['upsert', 'ready']);
    // Activation after ingestion is the whole point: the config must name the namespace that was just built.
    assert.ok((await fs.readFile(configPath, 'utf8')).includes(forced.namespace));
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
        workers: live(),
        post: async () => ({ result: { data: [Array(AI_CONFIG.embedding.dimensions).fill(0.1)] } }),
        vectorize: {
            indexes: {
                upsert: async () => {
                    calls.push('upsert');
                    return { mutationId: 'accepted' };
                },
            },
        },
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

test('a failed refresh step leaves the Wrangler configuration untouched', async (t) => {
    const withActive = (client, value) => (client.workers = live(value));
    for (const { name, arrange, wait, error } of [
        {
            name: 'embedding fails with no deployed Worker',
            arrange: (client) => (client.post = async () => Promise.reject(new Error('embedding failed'))),
            error: /embedding failed/,
        },
        {
            name: 'embedding fails for a changed corpus (a different active namespace requires ingestion)',
            arrange: (client) => {
                withActive(client, namespace);
                client.post = async () => Promise.reject(new Error('embedding failed'));
            },
            error: /embedding failed/,
        },
        {
            name: 'indexing never becomes ready',
            wait: async () => Promise.reject(new Error('not ready')),
            error: /not ready/,
        },
        {
            name: 'the Worker lookup fails',
            arrange: (client) =>
                (client.workers.scripts.scriptAndVersionSettings.get = async () => Promise.reject(new Error('Worker settings unavailable'))),
            error: /Worker settings unavailable/,
        },
        { name: 'the active namespace is invalid', arrange: (client) => withActive(client, 'invalid'), error: /Invalid active corpus namespace/ },
    ]) {
        const f = await refreshFixture(t);
        arrange?.(f.client);
        await assert.rejects(refreshCorpus({ client: f.client, accountId: 'account', root: f.root, wait: wait ?? f.wait }), error, name);
        assert.equal(await fs.readFile(f.configPath, 'utf8'), config, name);
    }
});

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

test('SDK transport reads the live Worker settings with the documented request', async (t) => {
    const { root, configPath } = await refreshFixture(t);
    const corpus = await buildCorpus({ root });
    const requests = [];
    const client = createMaintenanceClient('test-token', async (url) => {
        const pathname = new URL(url).pathname;
        requests.push(pathname);
        assert.equal(pathname, '/client/v4/accounts/account/workers/scripts/sg/settings');
        return Response.json({ success: true, result: { bindings: [{ type: 'plain_text', name: 'AI_CORPUS_NAMESPACE', text: corpus.namespace }] } });
    });
    const result = await refreshCorpus({ client, accountId: 'account', root });
    assert.equal(result.skipped, true);
    assert.equal(requests.length, 1);
    assert.ok((await fs.readFile(configPath, 'utf8')).includes(corpus.namespace));
});

test('unchanged corpus skips all embeddings, uploads and readiness waits but sets namespace', async (t) => {
    const { root, configPath, client } = await refreshFixture(t);
    client.post = async () => {
        assert.fail('Unexpected embedding request');
    };
    client.vectorize.indexes.upsert = async () => {
        assert.fail('Unexpected upload');
    };
    const corpus = await buildCorpus({ root });
    client.workers = live(corpus.namespace);
    const reused = await refreshCorpus({
        client,
        accountId: 'account',
        root,
        wait: async () => {
            assert.fail('Unchanged corpus must not wait for ingestion');
        },
    });
    assert.equal(reused.skipped, true);
    assert.deepEqual(reused.mutationIds, []);
    assert.ok((await fs.readFile(configPath, 'utf8')).includes(corpus.namespace));
});

test('concurrent configuration edits survive refresh without activation overwrite', async (t) => {
    const { root, configPath, corpus } = await integrityFixture(t);
    const changed = '[vars]\nAI_MODEL = "gemma"\n';
    const client = {
        workers: live(),
        post: async () => ({ result: { data: [Array(corpus.embedding.dimensions).fill(0.1)] } }),
        vectorize: { indexes: { upsert: async () => ({ mutationId: 'accepted' }) } },
    };
    await assert.rejects(
        refreshCorpus({
            client,
            accountId: 'account',
            root,
            wait: async () => fs.writeFile(configPath, changed),
        }),
        /configuration changed/,
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), changed);
});
