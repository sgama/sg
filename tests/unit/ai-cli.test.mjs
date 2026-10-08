import { corpusFixture } from '../helpers/corpus.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as evaluate } from '../../scripts/ai-eval.mjs';
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
        if (pathname === `${base}/pages/projects/sg`) {
            result = { canonical_deployment: null };
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

test('comparison supports oracle and retrieved contexts and persists private reports', async (t) => {
    const f = await fixture(t);
    const args = ['--fixture', 'fixture.json', '--models', 'glm'];
    await evaluate(['retrieval', ...args, '--output', 'retrieval.json'], f);
    await evaluate(['compare', ...args, '--output', 'oracle.json'], f);
    await evaluate(['compare', ...args, '--retrieval-report', 'retrieval.json', '--output', 'retrieved.json'], f);
    for (const [name, mode] of [
        ['oracle', 'labeled-source'],
        ['retrieved', 'retrieved'],
    ]) {
        const report = JSON.parse(await readFile(`${name}.json`, 'utf8'));
        assert.equal(report.contextMode, mode);
        assert.equal(report.results.length, 2);
        assert.ok(report.results.every((result) => result.status === 'ok'));
        assert.equal((await stat(`${name}.json`)).mode & 0o777, 0o600);
    }
    const retrieved = JSON.parse(await readFile('retrieved.json', 'utf8'));
    assert.equal(typeof retrieved.retrievalHash, 'string');
});

test('oracle comparisons use the same supplemental canonical evidence semantics as retrieval', async (t) => {
    const f = await fixture(t);
    await mkdir(path.join(f.root, 'content/_context'));
    await writeFile(path.join(f.root, 'content/page.md'), '---\ntitle: Stack\n---\n## Deployment\n\nCanonical Hugo and Cloudflare architecture.');
    await writeFile(
        path.join(f.root, 'content/_context/curated.md'),
        '---\ntitle: Curated\nretrievalSource: content/page.md\nretrievalSection: Deployment\n---\nUnique curated rollback details.',
    );
    await writeFile(
        path.join(f.root, 'fixture.json'),
        JSON.stringify({
            version: 1,
            cases: [
                {
                    id: 'canonical',
                    query: 'Architecture?',
                    expectedSources: ['content/_context/curated.md'],
                    answerTerms: [['hugo']],
                    forbiddenTerms: [],
                },
            ],
        }),
    );
    let calls = 0;
    await evaluate(['compare', '--fixture', 'fixture.json', '--models', 'glm', '--output', 'canonical.json'], {
        fetchImpl: async (url, init) => {
            calls++;
            const payload = await new Request(url, init).json();
            assert.match(payload.messages[0].content, /Canonical Hugo and Cloudflare/);
            assert.match(payload.messages[0].content, /Unique curated rollback/);
            return new Response('data: {"choices":[{"index":0,"delta":{"content":"Hugo architecture."}}]}\n\ndata: [DONE]\n\n', {
                headers: { 'content-type': 'text/event-stream' },
            });
        },
    });
    assert.equal(calls, 1);
});

test('evaluation rejects invalid options before any network request', async (t) => {
    const f = await fixture(t);
    for (const [args, expected] of [
        [[], /Usage/],
        [['models', 'extra'], /Usage/],
        [['models', '--models', 'glm,glm'], /unique/],
        [['models', '--models', 'invalid'], /Unknown AI model/],
        [['validate', '--repeats', '21'], /repeats/],
        [['validate', '--min-hit-rate', '-1'], /min-hit-rate/],
        [['validate', '--min-answer-rate', '2'], /min-answer-rate/],
        [['validate', '--timeout-ms', '1'], /timeout-ms/],
        [['validate', '--fixture', 'fixture.json', '--namespace', 'old'], /Namespace/],
        [['release-check', '--fixture', 'fixture.json'], /reports? are required|--retrieval-report/],
    ])
        await assert.rejects(evaluate(args, f), expected);
    assert.equal(f.requests.length, 0);
});

test('model listing and dry-run plans are offline and count every generation case', async (t) => {
    const f = await fixture(t);
    await evaluate(['models'], f);
    assert.ok(JSON.parse(f.output.mock.calls.at(-1).arguments[0]).models.glm);
    await evaluate(['compare', '--fixture', 'fixture.json', '--models', 'glm,gemma', '--repeats', '2', '--dry-run'], f);
    const plan = JSON.parse(f.output.mock.calls.at(-1).arguments[0]);
    assert.equal(plan.maxGenerationCalls, 8);
    assert.equal(plan.namespace, f.corpus.namespace);
    assert.equal(plan.dryRun, true);
    await evaluate(['validate', '--fixture', 'fixture.json'], f);
    assert.equal(JSON.parse(f.output.mock.calls.at(-1).arguments[0]).maxGenerationCalls, 0);
    assert.equal(f.requests.length, 0);
});

test('refresh CLI activates after indexing, skips unchanged content and honors force', async (t) => {
    const f = await fixture(t);
    await refresh([], f);
    assert.match(await readFile('wrangler.toml', 'utf8'), new RegExp(f.corpus.namespace));
    assert.match(f.output.mock.calls.at(-1).arguments[0], /indexed/);
    const unchanged = {
        fetchImpl: async (url) => {
            const pathname = new URL(url).pathname;
            if (pathname.endsWith('/pages/projects/sg')) {
                return Response.json({
                    success: true,
                    result: { canonical_deployment: { id: 'active' } },
                });
            }
            assert.ok(pathname.endsWith('/deployments/active'));
            return Response.json({
                success: true,
                result: {
                    id: 'active',
                    environment: 'production',
                    env_vars: {
                        AI_CORPUS_NAMESPACE: { type: 'plain_text', value: f.corpus.namespace },
                    },
                },
            });
        },
    };
    await refresh([], unchanged);
    assert.match(f.output.mock.calls.at(-1).arguments[0], /ingestion skipped/);
    f.requests.length = 0;
    await refresh(['--force', '--config', 'wrangler.toml'], f);
    assert.ok(!f.requests.some((request) => request.includes('/pages/')));
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
    assert.match(result.stderr, /Corpus refresh failed: Missing/);
    assert.equal(f.requests.length, 0);
});

test('retrieval and generation failures write reports before failing the CLI', async (t) => {
    await fixture(t);
    const failed = { fetchImpl: async () => Response.json({ success: false }, { status: 400 }) };
    for (const command of ['retrieval', 'compare']) {
        await assert.rejects(evaluate([command, '--fixture', 'fixture.json', '--models', 'glm', '--output', `${command}.json`], failed), /failed/);
        const report = JSON.parse(await readFile(`${command}.json`, 'utf8'));
        assert.equal(report.results.length, 2);
        if (command === 'retrieval') {
            assert.ok(report.results.every((result) => result.error));
        } else {
            assert.equal(report.results[0].status, 'error');
            assert.equal(report.results[1].status, 'ok');
            assert.equal(report.results[1].abstained, true);
        }
    }
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
