import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import 'dotenv/config';
import { AI_CONFIG, buildMessages, getModel } from '../functions/_lib/application.js';
import { createCloudflareAi } from './lib/cloudflare-ai.mjs';
import { buildCorpus } from './lib/corpus.mjs';
import { compareModels, evaluateRetrieval, fixtureHash, validateFixture } from './lib/ai-evaluation.mjs';
import { createLocalAi, searchVectors } from './lib/local-ai.mjs';

export async function main(args = process.argv.slice(2), { fetchImpl = fetch } = {}) {
    const { values } = parseArgs({ args, options: {
        url: { type: 'string', default: 'http://127.0.0.1:11434' },
        model: { type: 'string', default: 'hf.co/unsloth/GLM-4.7-Flash-GGUF:GLM-4.7-Flash-UD-IQ3_XXS.gguf' },
        'context-tokens': { type: 'string', default: '4096' },
        'embedding-model': { type: 'string', default: 'BAAI/bge-base-en-v1.5' },
        'embedding-backend': { type: 'string', default: 'tei' },
        generation: { type: 'string', default: 'local' },
        'cloud-model': { type: 'string', default: AI_CONFIG.generation.defaultModel },
        'retrieval-only': { type: 'boolean', default: false },
        'retrieval-report': { type: 'string' },
        dimensions: { type: 'string', default: '768' },
        fixture: { type: 'string', default: 'tests/fixtures/ai-eval.json' },
        output: { type: 'string', default: 'reports/ai-local.json' },
        repeats: { type: 'string', default: '1' },
        'timeout-ms': { type: 'string', default: '120000' },
        'min-hit-rate': { type: 'string', default: '0.9' },
        'min-answer-rate': { type: 'string', default: '0.8' },
        'dry-run': { type: 'boolean', default: false },
    } });
    const dimensions = Number(values.dimensions);
    const repeats = Number(values.repeats);
    const timeoutMs = Number(values['timeout-ms']);
    const minHitRate = Number(values['min-hit-rate']);
    const minAnswerRate = Number(values['min-answer-rate']);
    const contextTokens = Number(values['context-tokens']);
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192
        || !Number.isInteger(repeats) || repeats < 1 || repeats > 20
        || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000
        || !Number.isInteger(contextTokens) || contextTokens < 1024 || contextTokens > 32768
        || [minHitRate, minAnswerRate].some(rate => !Number.isFinite(rate) || rate < 0 || rate > 1)
        || !['local', 'cloudflare'].includes(values.generation)
        || !['tei', 'ollama'].includes(values['embedding-backend'])
        || !values.model.trim() || !values['embedding-model'].trim()) {
        throw new Error('Invalid local evaluation settings');
    }
    const corpus = await buildCorpus({ embedding: { model: values['embedding-model'], dimensions } });
    const fixture = JSON.parse(await fs.readFile(values.fixture, 'utf8'));
    validateFixture(fixture, corpus.chunks);
    const model = values.generation === 'cloudflare' ? getModel(values['cloud-model'])
        : { id: values.model, completionLimitKey: 'max_tokens', parameters: {} };
    const report = {
        version: 1, kind: 'local-rag', backend: values['embedding-backend'],
        generationBackend: values.generation, timestamp: new Date().toISOString(),
        corpusHash: corpus.hash, namespace: corpus.namespace, counts: corpus.counts,
        fixtureHash: fixtureHash(fixture), promptHash: fixtureHash(buildMessages('__query__', '__context__')),
        embedding: corpus.embedding, chunking: corpus.chunking,
        embeddingPreprocessing: values['embedding-backend'] === 'tei'
            ? { normalize: true, truncate: true, note: 'TEI tokenizer/model limit; provider parity not guaranteed' } : null,
        embeddingPrefixes: values['embedding-model'].split(':')[0] === 'nomic-embed-text'
            ? { document: 'search_document: ', query: 'search_query: ' } : null,
        retrievalSettings: { ...AI_CONFIG.retrieval, indexName: 'in-memory-exact-cosine' },
        model, generationSettings: { ...(values.generation === 'local'
            ? { think: false, temperature: 0, num_gpu: -1, num_ctx: contextTokens } : model.parameters),
            maxCompletionTokens: AI_CONFIG.generation.maxCompletionTokens },
        repeats, thresholds: { minHitRate, minAnswerRate },
        costScope: values.generation === 'cloudflare'
            ? 'Estimated Cloudflare generation only; local embedding/hardware costs excluded'
            : 'Local GPU run; cloud token prices do not apply; electricity/hardware cost not measured',
        ...(process.env.AI_LOCAL_IMAGE_ID ? { containerImageId: process.env.AI_LOCAL_IMAGE_ID } : {}),
    };
    if (values['dry-run']) {
        const plan = { ...report, dryRun: true, maxGenerationCalls: fixture.cases.length * repeats };
        console.log(JSON.stringify(plan, null, 2));
        return plan;
    }
    const local = createLocalAi({ url: values.url, embeddingModel: corpus.embedding.model,
        dimensions, timeoutMs, embeddingBackend: values['embedding-backend'], fetchImpl });
    if (values['retrieval-report']) {
        const saved = JSON.parse(await fs.readFile(values['retrieval-report'], 'utf8'));
        if (saved.kind !== 'local-rag' || saved.corpusHash !== report.corpusHash
            || saved.fixtureHash !== report.fixtureHash || saved.promptHash !== report.promptHash
            || saved.backend !== report.backend
            || JSON.stringify(saved.retrievalSettings) !== JSON.stringify(report.retrievalSettings)
            || saved.retrieval?.results.length !== fixture.cases.length
            || fixture.cases.some(item => saved.retrieval.results.filter(result =>
                result.caseId === item.id && !result.error && typeof result.context === 'string').length !== 1)) {
            throw new Error('Local retrieval report does not match corpus, fixture or settings');
        }
        report.retrieval = saved.retrieval;
        report.embeddingGpu = saved.embeddingGpu;
        report.embeddingContainerImageId = saved.containerImageId;
        report.indexingMs = saved.indexingMs;
        report.retrievalTimestamp = saved.timestamp;
    } else {
    const vectors = [];
    const start = performance.now();
    for (let offset = 0; offset < corpus.chunks.length; offset += 8) {
        vectors.push(...await local.embed(corpus.chunks.slice(offset, offset + 8).map(chunk => chunk.text)));
    }
    report.indexingMs = performance.now() - start;
    report.embeddingGpu = await local.gpuEvidence(corpus.embedding.model);
    report.retrieval = await evaluateRetrieval({
        cases: fixture.cases,
        async retrieve(query) {
            const start = performance.now();
            const [vector] = await local.embed([query], 'query');
            const embedded = performance.now();
            const matches = searchVectors(corpus.chunks, vectors, vector);
            return { matches, embeddingMs: embedded - start, searchMs: performance.now() - embedded };
        },
    });
    }
    if (values['retrieval-only']) {
        await fs.mkdir(path.dirname(values.output), { recursive: true });
        await fs.writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
        if (report.retrieval.results.some(item => item.error)) throw new Error('Local retrieval requests failed');
        console.log(`Local retrieval hit@3: ${report.retrieval.hitRate}; report: ${values.output}`);
        return report;
    }
    if (report.retrieval.results.some(item => item.error)) {
        report.passed = false;
    } else {
        const contexts = Object.fromEntries(report.retrieval.results.map(item => [item.caseId, item.context]));
        const cloud = values.generation === 'cloudflare'
            ? createCloudflareAi({ namespace: corpus.namespace, timeoutMs, fetchImpl }) : null;
        const generation = createLocalAi({ url: values.url, embeddingModel: corpus.embedding.model,
            dimensions, timeoutMs, contextTokens, embeddingBackend: 'ollama', fetchImpl });
        report.comparison = await compareModels({
            cases: fixture.cases, models: [model.id], resolveModel: () => model,
            contexts, repeats,
            async run(id, input) {
                if (cloud) return cloud.run(id, input);
                const stream = await generation.run(id, input);
                try {
                    report.generationGpu = await generation.gpuEvidence(id);
                } catch (error) {
                    await stream.cancel(error);
                    throw error;
                }
                return stream;
            },
        });
        report.passed = report.retrieval.hitRate >= minHitRate
            && report.comparison.summaries[0].answerCheckRate >= minAnswerRate
            && report.comparison.results.every(item => item.status === 'ok'
                && (!fixture.cases.find(entry => entry.id === item.caseId).required || item.passed));
    }
    await fs.mkdir(path.dirname(values.output), { recursive: true });
    await fs.writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ passed: report.passed, hitRate: report.retrieval.hitRate,
        summaries: report.comparison?.summaries, report: values.output }, null, 2));
    if (!report.passed) throw new Error('Local RAG validation failed; inspect the report (not a Cloudflare release report)');
    return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`Local AI evaluation failed: ${error.message}`);
        process.exitCode = 1;
    });
}
