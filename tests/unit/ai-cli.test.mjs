import { corpusFixture } from '../helpers/corpus.mjs';
import { aiSearchMock } from '../helpers/ai-search.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as refresh } from '../../scripts/refresh_ai_corpus.mjs';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sg-ai-cli-'));
    const cwd = process.cwd();
    const env = { ...process.env };
    t.after(async () => {
        process.chdir(cwd);
        process.env = env;
        await rm(root, { recursive: true, force: true });
    });
    await mkdir(path.join(root, 'content'));
    await writeFile(path.join(root, 'content/page.md'), '---\ntitle: Stack\n---\nHugo and Cloudflare.');
    await writeFile(path.join(root, 'wrangler.toml'), '[vars]\nAI_MODEL = "glm"\n');
    process.chdir(root);
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    delete process.env.AI_GATEWAY_ID;
    const output = t.mock.method(console, 'log', () => {});
    const corpus = await buildCorpus({ root });
    const mock = aiSearchMock();
    return { root, corpus, mock, output, fetchImpl: mock.fetchImpl };
}

test('offline CLI needs no credentials, writes reproducible manifest, and import is side-effect safe', async (t) => {
    const root = await corpusFixture(t);
    const manifest = path.join(root, 'manifest.json');
    const script = path.resolve('scripts/ingest_corpus.mjs');
    const env = { ...process.env };
    delete env.CLOUDFLARE_ACCOUNT_ID;
    delete env.CLOUDFLARE_API_TOKEN;
    const result = spawnSync(process.execPath, [script, '--check', '--manifest', manifest], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const corpus = await buildCorpus({ root });
    assert.equal(JSON.parse(result.stdout).instance, corpus.instance);
    const saved = JSON.parse(await readFile(manifest, 'utf8'));
    assert.equal(saved.instance, corpus.instance);
    assert.equal(saved.hash, corpus.hash);
    assert.deepEqual(saved.index, corpus.index);
    assert.deepEqual(saved.counts, corpus.counts);
    assert.deepEqual(saved.sources, corpus.sources);
    assert.deepEqual(
        saved.items.map(({ key, metadata }) => ({ key, metadata })),
        corpus.items.map(({ key, metadata }) => ({ key, metadata })),
    );
    assert.ok(saved.items.every((item) => !Object.hasOwn(item, 'text')));
    const imported = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../../scripts/ingest_corpus.mjs', import.meta.url).href)})`],
        { env, encoding: 'utf8', timeout: 10000 },
    );
    assert.ifError(imported.error);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
    const rejected = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(rejected.error);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /--instance/);
});

test('refresh CLI activates after indexing, skips unchanged content and honors force', async (t) => {
    const f = await fixture(t);
    await refresh([], f);
    assert.match(await readFile('wrangler.toml', 'utf8'), new RegExp(f.corpus.instance));
    assert.match(f.output.mock.calls.at(-1).arguments[0], /indexed/);
    assert.equal(f.mock.uploads.length, 1);
    f.mock.vars = { AI_SEARCH_INSTANCE: f.corpus.instance };
    f.mock.uploads.length = 0;
    await refresh([], f);
    assert.match(f.output.mock.calls.at(-1).arguments[0], /ingestion skipped/);
    assert.equal(f.mock.uploads.length, 0);
    f.mock.requests.length = 0;
    await refresh(['--force', '--config', 'wrangler.toml'], f);
    assert.ok(
        f.mock.requests.some(({ pathname }) => pathname.includes('/workers/')),
        'a forced refresh still reads the live Worker to keep its previous instance',
    );
    assert.equal(f.mock.uploads.length, 1);
});

test('refresh CLI missing credentials fail explicitly, including the process entry point', async (t) => {
    const f = await fixture(t);
    delete process.env.CLOUDFLARE_API_TOKEN;
    await assert.rejects(refresh([], f), /Missing CLOUDFLARE/);
    const script = fileURLToPath(new URL('../../scripts/refresh_ai_corpus.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], {
        cwd: f.root,
        env: { ...process.env, CLOUDFLARE_API_TOKEN: '' },
        encoding: 'utf8',
        timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Corpus refresh failed: Error: Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN/);
    assert.equal(f.mock.requests.length, 0);
});
