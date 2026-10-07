import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AI_CONFIG, getModel, generationInput } from '../../functions/_lib/ai-config.js';
import { fixtureHash, validateFixture, evaluateRetrieval, compareModels, estimateCost, percentile } from '../../scripts/lib/ai-evaluation.mjs';
import { validateRetrievalReport, validateComparisonReport } from '../../scripts/ai-eval.mjs';
import { buildMessages } from '../../functions/_lib/config.js';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { makeStream } from '../helpers/index.mjs';

const known = { id: 'known', query: 'What is the stack?', expectedSources: ['content/a.md'],
    answerTerms: [['hugo'], ['cloudflare']], forbiddenTerms: ['wordpress'] };
const unknown = { id: 'unknown', query: 'Salary?', expectedSources: [],
    answerTerms: [["don't have enough reliable context"]], forbiddenTerms: [] };
const fixture = { version: 1, cases: [known, unknown] };

test('model registry is modular and rejects unknown models', () => {
    assert.equal(getModel('glm').id, getModel('@cf/zai-org/glm-4.7-flash').id);
    assert.throws(() => getModel('typo'), /Unknown AI model/);
    const llamaInput = generationInput(getModel('llama'), []);
    assert.equal(llamaInput.max_tokens, AI_CONFIG.generation.maxCompletionTokens);
    assert.equal(llamaInput.max_completion_tokens, undefined);
    assert.equal(generationInput(getModel('gemma'), []).chat_template_kwargs.enable_thinking, false);
});

test('evaluation fixtures validate actual source labels and unique cases', () => {
    validateFixture(fixture, [{ metadata: { source: 'content/a.md' } }]);
    assert.throws(() => validateFixture(fixture, []), /Missing labeled source/);
    assert.throws(() => validateFixture({ version: 1, cases: [known, known] },
        [{ metadata: { source: 'content/a.md' } }]), /unique IDs/);
});

test('compares multiple models on identical contexts, preserving aggregate cost and answer checks', async () => {
    const calls = [];
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    const report = await compareModels({
        cases: fixture.cases, models: ['glm', 'gemma'], repeats: 2,
        contexts: { known: 'Hugo and Cloudflare power the website.', unknown: '' },
        async run(model, payload) {
            calls.push({ model, payload });
            return makeStream(
                'data: {"choices":[{"index":0,"delta":{"reasoning_content":"private"}}]}\n',
                'data: {"choices":[{"index":0,"delta":{"content":"Hugo and Cloudflare"}}]}\n',
                `data: ${JSON.stringify({ response: '', usage })}\n`,
                'data: [DONE]\n',
            );
        },
    });
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0].payload.messages, calls[1].payload.messages);
    assert.equal(report.results.length, 8);
    assert.ok(report.results.every(item => item.passed));
    assert.equal(report.summaries[0].answerCheckRate, 1);
    assert.equal(report.summaries[0].usageCoverage, 1);
    assert.equal(report.summaries[0].estimatedGenerationCostUsd, 2 * estimateCost(usage, getModel('glm')));
    assert.ok(report.results.filter(item => !item.abstained).every(item => item.ttftMs >= 0));
    assert.ok(report.results.every(item => !item.answer.includes('private')));
});

test('failed and usage-less runs are explicit, not zero-cost successful results', async () => {
    const report = await compareModels({
        cases: [known], models: ['glm', 'gemma'], contexts: { known: 'Enough context for a model response' },
        async run(model) {
            if (model === getModel('glm').id) throw new Error('timeout');
            return makeStream('data: {"response":"Hugo and Cloudflare"}\n', 'data: [DONE]\n');
        },
    });
    assert.equal(report.results[0].status, 'error');
    assert.equal(report.results[0].error, 'timeout');
    assert.equal(report.results[1].estimatedGenerationCostUsd, null);
    assert.equal(report.summaries[0].successRate, 0);
    assert.equal(report.summaries[0].costComplete, false);
    assert.equal(report.summaries[0].estimatedGenerationCostUsd, null);
    assert.equal(report.summaries[1].estimatedGenerationCostUsd, null);
    assert.equal(estimateCost({ prompt_tokens: -1, completion_tokens: 3 }, getModel('glm')), null);
    assert.equal(percentile([], 0.95), null);
    assert.equal(percentile([3, 1, 2], 0.95), 3);
});

test('retrieval measures expected source hits, not keyword presence', async () => {
    const report = await evaluateRetrieval({
        cases: [known],
        retrieve: async () => ({ matches: [{ metadata: { text: 'Hugo Cloudflare', source: 'content/wrong.md' } }],
            embeddingMs: 5, searchMs: 7 }),
    });
    assert.equal(report.hitRate, 0);
    assert.equal(report.results[0].embeddingMs, 5);
    const failed = await evaluateRetrieval({ cases: [known], retrieve: async () => { throw new Error('down'); } });
    assert.equal(failed.hitRate, 0);
    assert.equal(failed.results[0].error, 'down');
});

test('release reports must match corpus, labels and retrieval configuration', () => {
    const report = {
        kind: 'retrieval', namespace: 'candidate', fixtureHash: fixtureHash(fixture),
        topK: AI_CONFIG.retrieval.topK, maxContextChars: AI_CONFIG.retrieval.maxContextChars,
        embeddingModel: AI_CONFIG.embedding.model,
        indexName: AI_CONFIG.retrieval.indexName, hitRate: 1,
        results: [{ caseId: 'known', sources: ['content/a.md'], context: 'Some context' }],
    };
    const options = { namespace: 'candidate', fixture, minHitRate: 0.9 };
    validateRetrievalReport(report, options);
    assert.throws(() => validateRetrievalReport({ ...report, namespace: 'old' }, options));
    assert.throws(() => validateRetrievalReport({ ...report, results: [] }, options));
    assert.throws(() => validateRetrievalReport({ ...report, results: [
        { ...report.results[0], sources: ['content/wrong.md'] },
    ] }, options));
    assert.throws(() => validateRetrievalReport({ ...report, topK: 99 }, options));
});

test('release-check CLI gates actual Wrangler settings and retrieved-context model results offline', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-ai-release-'));
    try {
        await fs.mkdir(path.join(root, 'content'));
        await fs.writeFile(path.join(root, 'content/a.md'), '---\ntitle: Test\n---\nHugo and Cloudflare power this portfolio.');
        const corpus = await buildCorpus({ root });
        const retrieval = {
            kind: 'retrieval', namespace: corpus.namespace, fixtureHash: fixtureHash(fixture),
            topK: AI_CONFIG.retrieval.topK, maxContextChars: AI_CONFIG.retrieval.maxContextChars,
            embeddingModel: AI_CONFIG.embedding.model,
            indexName: AI_CONFIG.retrieval.indexName, hitRate: 1,
            results: [{ caseId: 'known', sources: ['content/a.md'], context: 'Hugo and Cloudflare power this portfolio.' }],
        };
        const model = getModel('glm');
        const comparison = {
            kind: 'comparison', namespace: corpus.namespace, fixtureHash: fixtureHash(fixture),
            promptHash: fixtureHash(buildMessages('__query__', '__context__')),
            contextMode: 'retrieved', maxCompletionTokens: AI_CONFIG.generation.maxCompletionTokens,
            modelConfigurations: { [model.id]: model }, retrievalHash: fixtureHash(retrieval),
            results: [
                { caseId: 'known', modelId: model.id, repeat: 0, status: 'ok', answer: 'Hugo and Cloudflare' },
                { caseId: 'unknown', modelId: model.id, repeat: 0, status: 'ok', answer: "I don't have enough reliable context" },
            ],
        };
        const options = { namespace: corpus.namespace, fixture, model, minAnswerRate: 0.8, retrievalReport: retrieval };
        validateComparisonReport(comparison, options);
        assert.throws(() => validateComparisonReport({ ...comparison, promptHash: 'stale' }, options));
        assert.throws(() => validateComparisonReport({ ...comparison, retrievalHash: 'stale' }, options));
        assert.throws(() => validateComparisonReport({ ...comparison, results: [] }, options));
        assert.throws(() => validateComparisonReport({ ...comparison,
            results: comparison.results.map(item => ({ ...item, answer: 'wrong' })) }, options));
        for (const [name, data] of [['fixture', fixture], ['retrieval', retrieval], ['comparison', comparison]]) {
            await fs.writeFile(path.join(root, `${name}.json`), JSON.stringify(data));
        }
        await fs.writeFile(path.join(root, 'wrangler.toml'),
            `[vars]\nAI_MODEL = "glm"\nAI_CORPUS_NAMESPACE = "${corpus.namespace}"\n\n[[vectorize]]\nbinding = "VECTORIZE_INDEX"\n`);
        const args = [
            fileURLToPath(new URL('../../scripts/ai-eval.mjs', import.meta.url)),
            'release-check', '--namespace', corpus.namespace,
            '--fixture', 'fixture.json', '--retrieval-report', 'retrieval.json', '--comparison-report', 'comparison.json',
        ];
        const passed = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
        assert.equal(passed.status, 0, passed.stderr);
        assert.match(passed.stdout, /Release gate passed/);
        await fs.writeFile(path.join(root, 'wrangler.toml'), '[vars]\nAI_MODEL = "glm"\nAI_CORPUS_NAMESPACE = "old"\n');
        const failed = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
        assert.notEqual(failed.status, 0);
        assert.match(failed.stderr, /AI_CORPUS_NAMESPACE/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
