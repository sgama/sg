import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalAi, normalizeVector, searchVectors } from '../../scripts/lib/local-ai.mjs';
import { main } from '../../scripts/ai-local-eval.mjs';
import { readAnswer } from '../../scripts/lib/ai-evaluation.mjs';

const options = {
    url: 'http://127.0.0.1:11434',
    embeddingModel: 'embed',
    dimensions: 2,
    timeoutMs: 1000,
};
const stream = (text) => new Response(text, { headers: { 'Content-Type': 'application/x-ndjson' } });

test('embeddings require complete finite vectors and actual GPU residency', async () => {
    for (const embeddings of [[], [[1]], [[0, 0]], [[1, null]]]) {
        const client = createLocalAi({
            ...options,
            fetchImpl: async () => Response.json({ embeddings }),
        });
        await assert.rejects(client.embed(['text']), /Incomplete|Invalid|zero magnitude/);
    }
    const client = createLocalAi({
        ...options,
        fetchImpl: async (url, init) => {
            if (url.pathname === '/api/embed') {
                const body = JSON.parse(init.body);
                assert.equal(body.truncate, false);
                assert.equal(body.options.num_gpu, -1);
                return Response.json({ embeddings: [[3, 4]] });
            }
            return Response.json({
                models: [{ name: 'embed:latest', size_vram: 100, digest: 'digest' }],
            });
        },
    });
    assert.deepEqual(await client.embed(['text']), [[0.6, 0.8]]);
    assert.equal((await client.gpuEvidence('embed')).digest, 'digest');
    const cpu = createLocalAi({
        ...options,
        fetchImpl: async () =>
            Response.json({
                models: [{ name: 'embed', size_vram: 0 }],
            }),
    });
    await assert.rejects(cpu.gpuEvidence('embed'), /not using the GPU/);
});

test('exact cosine search ranks chunks deterministically without a database', () => {
    const chunks = ['b', 'a', 'c'].map((id) => ({ id, metadata: { source: id } }));
    const matches = searchVectors(
        chunks,
        [
            [1, 0],
            [1, 0],
            [0, 1],
        ],
        [1, 0],
        2,
    );
    assert.deepEqual(
        matches.map((item) => item.id),
        ['a', 'b'],
    );
    assert.equal(matches[0].score, 1);
    assert.throws(() => searchVectors(chunks, [], [1, 0]), /Incomplete/);
    assert.throws(() => normalizeVector([Infinity, 0], 2), /Invalid/);
});

test('local retrieval expands only the matched section and deduplicates siblings', () => {
    const source = 'content/project.md';
    const parent = { id: 'parent', metadata: { source, recordType: 'section', sectionIndex: -1, text: 'Deploy and roll back the project' } };
    const chunks = [
        { id: 'a', metadata: { source, parentIndex: -1, text: 'Deploy' } },
        { id: 'b', metadata: { source, parentIndex: -1, text: 'Roll back' } },
        parent,
        { id: 'unrelated', metadata: { source: 'content/resume/_index.md', recordType: 'section', sectionIndex: -1, text: 'Unrelated resume' } },
    ];
    const matches = searchVectors(
        chunks,
        [
            [1, 0],
            [0.9, 0.1],
            [0, 1],
            [0, 1],
        ],
        [1, 0],
        2,
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, parent.id);
    assert.equal(matches[0].metadata.text, parent.metadata.text);
    assert.equal(matches[0].score, 1);
    assert.throws(
        () =>
            searchVectors(
                chunks.slice(0, 2),
                [
                    [1, 0],
                    [1, 0],
                ],
                [1, 0],
            ),
        /Missing or invalid parent/,
    );
});

test('local CLI writes private provenance, reuses evaluator and gates required answers', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-local-eval-'));
    const original = process.cwd();
    t.after(async () => {
        process.chdir(original);
        await fs.rm(root, { recursive: true, force: true });
    });
    await fs.mkdir(path.join(root, 'content'));
    await fs.writeFile(path.join(root, 'content/page.md'), 'Hugo and Cloudflare.');
    await fs.writeFile(
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
                    required: true,
                },
            ],
        }),
    );
    process.chdir(root);
    let answer = 'Hugo';
    let requests = 0;
    const fetchImpl = async (url) => {
        requests++;
        if (url.pathname === '/embed') return Response.json([[1, 0]]);
        if (url.pathname === '/info') return Response.json({ model_id: 'embed' });
        if (url.pathname === '/api/ps')
            return Response.json({
                models: [
                    { name: 'embed', digest: 'embed-digest', size_vram: 100 },
                    { name: 'local', digest: 'local-digest', size_vram: 1000 },
                ],
            });
        return stream(`${JSON.stringify({ message: { content: answer } })}\n` + '{"done":true,"prompt_eval_count":10,"eval_count":2}\n');
    };
    const args = ['--model', 'local', '--embedding-model', 'embed', '--dimensions', '2', '--fixture', 'fixture.json', '--output', 'report.json'];
    t.mock.method(console, 'log', () => {});
    const dry = await main([...args, '--dry-run'], { fetchImpl });
    assert.equal(dry.dryRun, true);
    assert.equal(requests, 0);
    const report = await main(args, { fetchImpl });
    assert.equal(report.passed, true);
    assert.equal(report.kind, 'local-rag');
    assert.equal(report.retrieval.hitRate, 1);
    assert.equal(report.generationGpu.digest, 'local-digest');
    assert.equal(report.comparison.results[0].estimatedGenerationCostUsd, null);
    assert.equal(report.comparison.results[0].usage.completion_tokens, 2);
    assert.equal(report.comparison.summaries[0].usageCoverage, 1);
    assert.equal(report.comparison.summaries[0].costComplete, false);
    assert.equal((await fs.stat('report.json')).mode & 0o777, 0o600);
    const retrieval = await main([...args, '--retrieval-only', '--output', 'retrieval.json'], {
        fetchImpl,
    });
    assert.equal(retrieval.comparison, undefined);
    const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const previousToken = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_ACCOUNT_ID = 'offline';
    process.env.CLOUDFLARE_API_TOKEN = 'offline';
    t.after(() => {
        for (const [key, value] of [
            ['CLOUDFLARE_ACCOUNT_ID', previousAccount],
            ['CLOUDFLARE_API_TOKEN', previousToken],
        ]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    const hybrid = await main([...args, '--generation', 'cloudflare', '--retrieval-report', 'retrieval.json'], {
        fetchImpl: async (url, init) => {
            assert.match(String(url), /accounts\/offline\/ai\/run\/@cf\/zai-org\/glm-4.7-flash$/);
            const body = JSON.parse(init.body);
            assert.equal(body.chat_template_kwargs.enable_thinking, false);
            assert.equal(body.max_completion_tokens, 512);
            return new Response('data: {"response":"Hugo"}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n', {
                headers: { 'Content-Type': 'text/event-stream' },
            });
        },
    });
    assert.equal(hybrid.generationBackend, 'cloudflare');
    assert.equal(hybrid.comparison.summaries[0].costComplete, true);
    const tampered = { ...retrieval, corpusHash: 'wrong' };
    await fs.writeFile('tampered.json', JSON.stringify(tampered));
    await assert.rejects(main([...args, '--retrieval-report', 'tampered.json'], { fetchImpl }), /does not match/);
    answer = 'Unsupported';
    await assert.rejects(main([...args, '--min-answer-rate', '0'], { fetchImpl }), /validation failed/);
    assert.equal(JSON.parse(await fs.readFile('report.json', 'utf8')).passed, false);
    await assert.rejects(main([...args, '--repeats', '0'], { fetchImpl }), /Invalid/);
});

test('local streaming adapts fragmented NDJSON, omits thinking and retains usage', async () => {
    const client = createLocalAi({
        ...options,
        fetchImpl: async (_, init) => {
            const body = JSON.parse(init.body);
            assert.equal(body.think, false);
            assert.equal(body.options.num_predict, 512);
            assert.equal(body.options.num_ctx, 4096);
            const bytes = new TextEncoder().encode(
                '{"message":{"thinking":"hidden","content":"Café"}}\n' + '{"done":true,"prompt_eval_count":10,"eval_count":3}',
            );
            return new Response(
                new ReadableStream({
                    start(controller) {
                        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
                        controller.close();
                    },
                }),
            );
        },
    });
    const output = await readAnswer(await client.run('local', { messages: [], max_tokens: 512 }), {
        start: performance.now(),
    });
    assert.equal(output.answer, 'Café');
    assert.deepEqual(output.usage, { prompt_tokens: 10, completion_tokens: 3 });
});

test('TEI embeds BGE without task prefixes and rejects mismatched model identity', async () => {
    const client = createLocalAi({
        ...options,
        embeddingModel: 'BAAI/bge-base-en-v1.5',
        embeddingBackend: 'tei',
        fetchImpl: async (url, init) => {
            if (url.pathname === '/embed') {
                assert.deepEqual(JSON.parse(init.body), {
                    inputs: ['question'],
                    truncate: true,
                    normalize: true,
                });
                return Response.json([[3, 4]]);
            }
            return Response.json({ model_id: 'BAAI/bge-base-en-v1.5' });
        },
    });
    assert.deepEqual(await client.embed(['question'], 'query'), [[0.6, 0.8]]);
    assert.equal((await client.gpuEvidence('unused')).model, 'BAAI/bge-base-en-v1.5');
    const invalid = createLocalAi({
        ...options,
        embeddingBackend: 'tei',
        fetchImpl: async () => Response.json({ model_id: 'other' }),
    });
    await assert.rejects(invalid.gpuEvidence('embed'), /Unexpected/);
});

test('local transport rejects remote endpoints, HTTP failures and incomplete streams', async () => {
    assert.throws(() => createLocalAi({ ...options, url: 'https://example.com' }), /loopback/);
    const failed = createLocalAi({
        ...options,
        fetchImpl: async () => new Response('', { status: 500 }),
    });
    await assert.rejects(failed.embed(['text']), /HTTP 500/);
    for (const text of ['{"message":{"content":"partial"}}\n', '{"error":"out of memory"}\n', 'not json\n']) {
        const client = createLocalAi({ ...options, fetchImpl: async () => stream(text) });
        await assert.rejects(
            readAnswer(await client.run('local', { messages: [], max_tokens: 512 }), {
                start: performance.now(),
            }),
            /without completion|out of memory|JSON/,
        );
    }
});
