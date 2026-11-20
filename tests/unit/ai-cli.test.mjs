import { corpusFixture } from '../helpers/corpus.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as refresh } from '../../scripts/refresh_ai_corpus.mjs';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { AI_CONFIG } from '../../functions/_lib/application.js';

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
    await writeFile(
        path.join(root, 'fixture.json'),
        JSON.stringify({
            version: 1,
            cases: [
                {
                    id: 'stack',
                    query: 'Stack?',
                    expectedSources: ['content/page.md'],
                    answerTerms: [['hugo']],
                    forbiddenTerms: [],
                },
                {
                    id: 'salary',
                    query: 'Salary?',
                    expectedSources: [],
                    answerTerms: [['unknown']],
                    forbiddenTerms: [],
                },
            ],
        }),
    );
    await writeFile(path.join(root, 'wrangler.toml'), '[vars]\nAI_MODEL = "glm"\n');
    process.chdir(root);
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    delete process.env.PROJECT_NAME;
    const output = t.mock.method(console, 'log', () => {});
    const corpus = await buildCorpus({ root });
    const requests = [];
    const fetchImpl = async (url, init) => {
        const request = new Request(url, init);
        const pathname = decodeURIComponent(new URL(request.url).pathname);
        requests.push(pathname);
        const base = '/client/v4/accounts/account';
        let result;
        if (pathname === `${base}/workers/scripts/sg/settings`) {
            return Response.json({ success: false, errors: [{ code: 10007, message: 'This Worker does not exist' }] }, { status: 404 });
        } else if (pathname === `${base}/ai/run/${AI_CONFIG.embedding.model}`) {
            result = { data: [Array(AI_CONFIG.embedding.dimensions).fill(0.1)] };
        } else if (pathname === `${base}/vectorize/v2/indexes/portfolio-index/query`) {
            result = {
                matches: [{ id: corpus.chunks[0].id, metadata: corpus.chunks[0].metadata }],
            };
        } else if (pathname === `${base}/vectorize/v2/indexes/portfolio-index/upsert`) {
            assert.match(await request.text(), /"namespace":"corpus-/);
            result = { mutationId: 'accepted' };
        } else if (pathname === `${base}/vectorize/v2/indexes/portfolio-index/info`) {
            result = {
                dimensions: AI_CONFIG.embedding.dimensions,
                processedUpToMutation: 'accepted',
            };
        } else {
            assert.match(pathname, /\/ai\/run\/@cf\/zai-org\/glm-4.7-flash$/);
            return new Response('data: {"choices":[{"index":0,"delta":{"content":"Hugo; salary unknown."}}]}\n\ndata: [DONE]\n\n', {
                headers: { 'content-type': 'text/event-stream' },
            });
        }
        return Response.json({ success: true, result });
    };
    return { root, corpus, requests, output, fetchImpl };
}

test('refresh CLI activates after indexing, skips unchanged content and honors force', async (t) => {
    const f = await fixture(t);
    await refresh([], f);
    assert.match(await readFile('wrangler.toml', 'utf8'), new RegExp(f.corpus.namespace));
    assert.match(f.output.mock.calls.at(-1).arguments[0], /indexed/);
    const unchanged = {
        fetchImpl: async (url) => {
            assert.ok(new URL(url).pathname.endsWith('/workers/scripts/sg/settings'));
            return Response.json({
                success: true,
                result: { bindings: [{ type: 'plain_text', name: 'AI_CORPUS_NAMESPACE', text: f.corpus.namespace }] },
            });
        },
    };
    await refresh([], unchanged);
    assert.match(f.output.mock.calls.at(-1).arguments[0], /ingestion skipped/);
    f.requests.length = 0;
    await refresh(['--force', '--config', 'wrangler.toml'], f);
    assert.ok(
        f.requests.some((request) => request.includes('/workers/')),
        'a forced refresh still reads the live Worker to keep its previous namespace',
    );
    assert.ok(f.requests.some((request) => request.endsWith('/info')));
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
    assert.equal(f.requests.length, 0);
});

test('offline CLI needs no credentials, writes reproducible manifest, and import is side-effect safe', async (t) => {
    const root = await corpusFixture(t);
    const manifest = path.join(root, 'manifest.json');
    const script = path.resolve('scripts/generate_embeddings.mjs');
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
    assert.equal(JSON.parse(result.stdout).namespace, (await buildCorpus({ root })).namespace);
    const { readFile } = await import('node:fs/promises');
    const saved = JSON.parse(await readFile(manifest, 'utf8'));
    const corpus = await buildCorpus({ root });
    assert.equal(saved.namespace, corpus.namespace);
    assert.equal(saved.hash, corpus.hash);
    assert.deepEqual(saved.embedding, corpus.embedding);
    assert.deepEqual(saved.counts, corpus.counts);
    assert.deepEqual(saved.sources, corpus.sources);
    assert.deepEqual(
        saved.chunks.map(({ id }) => id),
        corpus.chunks.map(({ id }) => id),
    );
    assert.ok(saved.chunks.every((chunk) => !Object.hasOwn(chunk, 'text') && !Object.hasOwn(chunk.metadata, 'text')));
    const imported = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../../scripts/generate_embeddings.mjs', import.meta.url).href)})`],
        { env, encoding: 'utf8', timeout: 10000 },
    );
    assert.ifError(imported.error);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
    const rejected = spawnSync(process.execPath, [script], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 10000,
    });
    assert.ifError(rejected.error);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /--namespace/);
});
