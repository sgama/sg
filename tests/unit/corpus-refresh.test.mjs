import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AI_CONFIG } from '../../functions/_lib/config.js';
import { refreshCorpus, setCorpusNamespace, waitForMutation } from '../../scripts/refresh_ai_corpus.mjs';

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

test('refresh activates only after successful ingestion and readiness; failures leave config untouched', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-corpus-refresh-'));
    try {
        await fs.mkdir(path.join(root, 'content'));
        await fs.writeFile(path.join(root, 'content/page.md'), '---\ntitle: Test\n---\nCurrent content.');
        const configPath = path.join(root, 'wrangler.toml');
        await fs.writeFile(configPath, config);
        const calls = [];
        const client = {
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
        const result = await refreshCorpus({ client, accountId: 'account', root, wait });
        assert.deepEqual(calls, ['upsert', 'ready']);
        assert.ok((await fs.readFile(configPath, 'utf8')).includes(result.namespace));

        await fs.writeFile(configPath, config);
        await assert.rejects(refreshCorpus({ client, accountId: 'account', root,
            wait: async () => { throw new Error('not ready'); } }), /not ready/);
        assert.equal(await fs.readFile(configPath, 'utf8'), config);

        client.ai.run = async () => { throw new Error('embedding failed'); };
        await assert.rejects(refreshCorpus({ client, accountId: 'account', root, wait }), /embedding failed/);
        assert.equal(await fs.readFile(configPath, 'utf8'), config);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
