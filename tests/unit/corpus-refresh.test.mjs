import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { createMaintenanceClient, ingestCorpus, refreshCorpus, setSearchInstance } from '../../scripts/lib/corpus-deployment.mjs';
import { aiSearchMock } from '../helpers/ai-search.mjs';

const instance = `portfolio-${'a'.repeat(12)}`;
const config = '[ai]\nbinding = "AI"\n\n[vars]\nAI_MODEL = "glm"\n\n[[ai_search_namespaces]]\nbinding = "AI_SEARCH"\n';
const fast = { intervalMs: 1, timeoutMs: 2000 };

async function refreshFixture(t, mockOptions) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-corpus-refresh-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'content'));
    await fs.writeFile(path.join(root, 'content/page.md'), '---\ntitle: Test\n---\nCurrent content.');
    const configPath = path.join(root, 'wrangler.toml');
    await fs.writeFile(configPath, config);
    const corpus = await buildCorpus({ root });
    const mock = aiSearchMock(typeof mockOptions === 'function' ? mockOptions(corpus) : mockOptions);
    const client = createMaintenanceClient('token', mock.fetchImpl);
    const ingest = (c, accountId, built, options) => ingestCorpus(c, accountId, built, { ...options, ...fast });
    return { root, configPath, corpus, mock, client, ingest };
}

test('a failed refresh step leaves the Wrangler configuration untouched', async (t) => {
    for (const { name, options, ingest, error } of [
        { name: 'ingestion fails', options: { vars: null }, ingest: async () => Promise.reject(new Error('ingest failed')), error: /ingest failed/ },
        { name: 'the upload fails', options: (corpus) => ({ vars: null, failUploadKey: corpus.items[0].key }), error: /400|boom/ },
        { name: 'the active instance is invalid', options: { vars: { AI_SEARCH_INSTANCE: 'invalid' } }, error: /Invalid active AI Search instance/ },
    ]) {
        const f = await refreshFixture(t, options);
        await assert.rejects(refreshCorpus({ client: f.client, accountId: 'account', root: f.root, ingest: ingest ?? f.ingest }), error, name);
        assert.equal(await fs.readFile(f.configPath, 'utf8'), config, name);
    }
    const f = await refreshFixture(t, { vars: null });
    const broken = createMaintenanceClient('token', async () => Response.json({ success: false }, { status: 500 }));
    await assert.rejects(refreshCorpus({ client: broken, accountId: 'account', root: f.root }));
    assert.equal(await fs.readFile(f.configPath, 'utf8'), config);
});

test('concurrent configuration edits survive refresh without activation overwrite', async (t) => {
    const { root, configPath, client } = await refreshFixture(t, { vars: null });
    const changed = '[vars]\nAI_MODEL = "gemma"\n';
    await assert.rejects(
        refreshCorpus({
            client,
            accountId: 'account',
            root,
            ingest: async (c, accountId, built) => {
                await fs.writeFile(configPath, changed);
                return { instance: built.instance, count: 1, uploaded: 1, reused: 0 };
            },
        }),
        /configuration changed/,
    );
    assert.equal(await fs.readFile(configPath, 'utf8'), changed);
});

test('force refresh ingests even when the Worker lookup is unavailable', async (t) => {
    const f = await refreshFixture(t, { vars: null });
    const unavailable = createMaintenanceClient('token', async (url, init) =>
        new URL(url).pathname.includes('/workers/') ? Response.json({ success: false }, { status: 500 }) : f.mock.fetchImpl(url, init),
    );
    const forced = await refreshCorpus({ client: unavailable, accountId: 'account', root: f.root, force: true, ingest: f.ingest });
    assert.equal(forced.skipped, false);
    assert.equal(forced.uploaded, 1);
    assert.ok((await fs.readFile(f.configPath, 'utf8')).includes(`AI_SEARCH_INSTANCE = "${f.corpus.instance}"`));
});

test('instance activation only changes the Wrangler vars section and preserves all bindings', () => {
    const previous = `portfolio-${'b'.repeat(12)}`;
    const updated = setSearchInstance(config, instance, previous);
    assert.equal(updated, config.replace('[vars]\n', `[vars]\nAI_SEARCH_INSTANCE = "${instance}"\nAI_PREVIOUS_SEARCH_INSTANCE = "${previous}"\n`));
    assert.equal(setSearchInstance(updated, instance, previous), updated);
    const next = `portfolio-${'c'.repeat(12)}`;
    assert.ok(setSearchInstance(updated, next, previous).includes(next));
    assert.equal(setSearchInstance(updated, next), updated.replace(instance, next).replace(`AI_PREVIOUS_SEARCH_INSTANCE = "${previous}"\n`, ''));
    assert.equal(setSearchInstance(config, instance), config.replace('[vars]\n', `[vars]\nAI_SEARCH_INSTANCE = "${instance}"\n`));
    assert.throws(() => setSearchInstance(config, 'bad'), /Invalid AI Search instance/);
    assert.throws(() => setSearchInstance(config, instance, 'bad'), /Invalid previous/);
    assert.throws(() => setSearchInstance('[ai]\nbinding = "AI"', instance), /vars/);
    assert.throws(() => setSearchInstance(`[vars]\nAI_SEARCH_INSTANCE = "a"\nAI_SEARCH_INSTANCE = "b"\n`, instance), /Duplicate/);
});

test('refresh records the instance it replaces as previous, and keeps that record when the corpus is unchanged', async (t) => {
    const older = `portfolio-${'d'.repeat(12)}`;
    const f = await refreshFixture(t, { vars: { AI_SEARCH_INSTANCE: older, AI_PREVIOUS_SEARCH_INSTANCE: `portfolio-${'e'.repeat(12)}` } });
    const changed = await refreshCorpus({ client: f.client, accountId: 'account', root: f.root, ingest: f.ingest });
    assert.equal(changed.skipped, false);
    assert.ok((await fs.readFile(f.configPath, 'utf8')).includes(`AI_PREVIOUS_SEARCH_INSTANCE = "${older}"`));
    f.mock.vars = { AI_SEARCH_INSTANCE: changed.instance, AI_PREVIOUS_SEARCH_INSTANCE: older };
    const unchanged = await refreshCorpus({ client: f.client, accountId: 'account', root: f.root, ingest: f.ingest });
    assert.equal(unchanged.skipped, true);
    assert.ok((await fs.readFile(f.configPath, 'utf8')).includes(`AI_PREVIOUS_SEARCH_INSTANCE = "${older}"`));
});

test('refresh skips a complete live instance but repairs a missing or incomplete one', async (t) => {
    const f = await refreshFixture(t, (corpus) => ({
        vars: { AI_SEARCH_INSTANCE: corpus.instance },
        instances: { [corpus.instance]: corpus.items.map((item) => item.key) },
    }));
    const skipped = await refreshCorpus({
        client: f.client,
        accountId: 'account',
        root: f.root,
        ingest: async () => assert.fail('A complete live instance must not be ingested'),
    });
    assert.equal(skipped.skipped, true);
    assert.deepEqual(f.mock.uploads, []);
    assert.ok((await fs.readFile(f.configPath, 'utf8')).includes(f.corpus.instance));
    for (const keys of [undefined, []]) {
        const g = await refreshFixture(t, (corpus) => ({
            vars: { AI_SEARCH_INSTANCE: corpus.instance },
            instances: keys ? { [corpus.instance]: keys } : {},
        }));
        const repaired = await refreshCorpus({ client: g.client, accountId: 'account', root: g.root, ingest: g.ingest });
        assert.equal(repaired.skipped, false);
        assert.equal(g.mock.uploads.length, 1);
    }
});
