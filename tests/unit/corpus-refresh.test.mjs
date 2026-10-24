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
const config = '[ai]\nbinding = "AI"\n\n[vars]\nAI_MODEL = "glm"\n\n[[vectorize]]\nindex_name = "portfolio-index"\n';

test('force refresh ingests even when Pages lookup is unavailable', async (t) => {
    const { root, client, wait, calls } = await refreshFixture(t);
    client.pages.projects.get = async () => {
        throw new Error('Pages unavailable');
    };
    const forced = await refreshCorpus({ client, accountId: 'account', root, wait, force: true });
    assert.equal(forced.skipped, false);
    assert.deepEqual(calls, ['upsert', 'ready']);
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
    const active = (value) => async () => ({
        id: 'active',
        environment: 'production',
        env_vars: { AI_CORPUS_NAMESPACE: { type: 'plain_text', value } },
    });
    const withActive = (client, value) => {
        client.pages.projects.get = async () => ({ canonical_deployment: { id: 'active' } });
        client.pages.projects.deployments = { get: active(value) };
    };
    for (const { name, arrange, wait, error } of [
        {
            name: 'embedding fails with no active deployment',
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
            name: 'the Pages lookup fails',
            arrange: (client) => (client.pages.projects.get = async () => Promise.reject(new Error('Pages unavailable'))),
            error: /Pages unavailable/,
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

test('refresh activates only after successful ingestion and readiness', async (t) => {
    const { root, configPath, client, calls, wait } = await refreshFixture(t);
    const result = await refreshCorpus({ client, accountId: 'account', root, wait });
    assert.deepEqual(calls, ['upsert', 'ready']);
    assert.ok((await fs.readFile(configPath, 'utf8')).includes(result.namespace));
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
        return Response.json({
            success: true,
            result:
                pathname === base
                    ? { canonical_deployment: { id: 'active' } }
                    : {
                          id: 'active',
                          environment: 'production',
                          env_vars: {
                              AI_CORPUS_NAMESPACE: { type: 'plain_text', value: corpus.namespace },
                          },
                      },
        });
    });
    const result = await refreshCorpus({ client, accountId: 'account', root });
    assert.equal(result.skipped, true);
    assert.equal(requests.length, 2);
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
    const snapshot = {
        id: 'active',
        environment: 'production',
        env_vars: { AI_CORPUS_NAMESPACE: { type: 'plain_text', value: corpus.namespace } },
    };
    client.pages.projects.get = async () => ({ canonical_deployment: { id: 'active' } });
    client.pages.projects.deployments = { get: async () => snapshot };
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
        pages: { projects: { get: async () => ({}) } },
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
