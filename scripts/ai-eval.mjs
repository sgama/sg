import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import 'dotenv/config';
import { AI_CONFIG, AI_MODELS, getModel, contextFromMatches, buildMessages } from '../functions/_lib/application.js';
import { buildCorpus } from './lib/corpus.mjs';
import { createCloudflareAi } from './lib/cloudflare-ai.mjs';
import { validateFixture, fixtureHash, scoreAnswer, evaluateRetrieval, compareModels } from './lib/ai-evaluation.mjs';

const promptHash = () => fixtureHash(buildMessages('__query__', '__context__'));

async function writeReport(output, report) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

export function validateRetrievalReport(report, { namespace, fixture, minHitRate }) {
    if (report.version !== 2 || report.kind !== 'retrieval' || report.namespace !== namespace || report.fixtureHash !== fixtureHash(fixture)
        || !Number.isFinite(report.hitRate) || report.hitRate < minHitRate
        || report.topK !== AI_CONFIG.retrieval.topK || report.embeddingModel !== AI_CONFIG.embedding.model
        || report.maxContextChars !== AI_CONFIG.retrieval.maxContextChars
        || report.indexName !== AI_CONFIG.retrieval.indexName
        || !Array.isArray(report.results)) throw new Error('Retrieval report does not pass this corpus/fixture release gate');
    const expected = fixture.cases;
    if (report.results.length !== expected.length) throw new Error('Retrieval report is incomplete');
    for (const item of expected) {
        const matches = report.results.filter(result => result.caseId === item.id);
        if (matches.length !== 1 || matches[0].error || typeof matches[0].context !== 'string') {
            throw new Error(`Retrieval report missing successful query ${item.id}`);
        }

    }
    const positives = expected.filter(item => item.expectedSources.length);
    const actualHitRate = report.results.filter(result => {
        const item = expected.find(entry => entry.id === result.caseId);
        return Array.isArray(result.sources) && item.expectedSources.some(source => result.sources.includes(source));
    }).length / positives.length;
    if (!Number.isFinite(actualHitRate) || actualHitRate < minHitRate
        || actualHitRate !== report.hitRate) throw new Error('Retrieval report source labels do not meet the release gate');
}

export function validateComparisonReport(report, { namespace, fixture, model, minAnswerRate, retrievalReport }) {
    if (report.kind !== 'comparison' || report.namespace !== namespace
        || report.fixtureHash !== fixtureHash(fixture) || report.promptHash !== promptHash()
        || report.contextMode !== 'retrieved'
        || report.maxCompletionTokens !== AI_CONFIG.generation.maxCompletionTokens
        || !Array.isArray(report.results)
        || JSON.stringify(report.modelConfigurations?.[model.id]) !== JSON.stringify(model)) {
        throw new Error('Comparison report does not match the selected model, prompt and retrieved corpus');
    }
    if (!retrievalReport || report.retrievalHash !== fixtureHash(retrievalReport)) {
        throw new Error('Comparison report must use the current validated retrieval report');
    }
    const samples = report.results.filter(item => item.modelId === model.id);
    const repeats = new Set(samples.map(item => item.repeat));
    if (!repeats.size || [...repeats].some(repeat => !Number.isInteger(repeat) || repeat < 0)) {
        throw new Error('Comparison report has no valid repetitions for selected model');
    }
    for (const repeat of repeats) {
        for (const item of fixture.cases) {
            const entries = samples.filter(sample => sample.caseId === item.id && sample.repeat === repeat);
            if (entries.length !== 1 || entries[0].status !== 'ok' || typeof entries[0].answer !== 'string') {
                throw new Error(`Comparison report missing successful answer for ${item.id}`);
            }
            if (item.required && !scoreAnswer(entries[0].answer, item)) {
                throw new Error(`Required answer regression failed for ${item.id} (repeat ${repeat})`);
            }
        }
    }
    if (samples.length !== repeats.size * fixture.cases.length) throw new Error('Unexpected comparison samples');
    const rate = samples.filter(sample => scoreAnswer(sample.answer,
        fixture.cases.find(item => item.id === sample.caseId))).length / samples.length;
    if (rate < minAnswerRate) throw new Error(`Selected model answer checks ${rate} below ${minAnswerRate}`);
}

export async function main(args = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: {
            models: { type: 'string', default: 'glm,gemma,llama' },
            fixture: { type: 'string', default: 'tests/fixtures/ai-eval.json' },
            namespace: { type: 'string' },
            output: { type: 'string' },
            'retrieval-report': { type: 'string' },
            'comparison-report': { type: 'string' },
            repeats: { type: 'string', default: '1' },
            'min-hit-rate': { type: 'string', default: '0.9' },
            'min-answer-rate': { type: 'string', default: '0.8' },
            'timeout-ms': { type: 'string', default: '60000' },
            'dry-run': { type: 'boolean', default: false },
        },
    });
    const command = positionals[0];
    if (positionals.length !== 1 || !['models', 'validate', 'retrieval', 'compare', 'release-check'].includes(command)) {
        throw new Error('Usage: ai-eval.mjs models|validate|retrieval|compare|release-check [options]');
    }
    const models = values.models.split(',').map(name => name.trim());
    if (new Set(models).size !== models.length) throw new Error('Model names must be unique');
    for (const name of models) getModel(name);
    if (command === 'models') {
        console.log(JSON.stringify({ pricingDate: AI_CONFIG.pricingDate, models: AI_MODELS }, null, 2));
        return;
    }
    const repeats = Number(values.repeats);
    const minHitRate = Number(values['min-hit-rate']);
    const timeoutMs = Number(values['timeout-ms']);
    const minAnswerRate = Number(values['min-answer-rate']);
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('repeats must be 1..20');
    if (!Number.isFinite(minHitRate) || minHitRate < 0 || minHitRate > 1) throw new Error('min-hit-rate must be 0..1');
    if (!Number.isFinite(minAnswerRate) || minAnswerRate < 0 || minAnswerRate > 1) throw new Error('min-answer-rate must be 0..1');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('timeout-ms must be 1000..300000');
    const corpus = await buildCorpus();
    const fixture = JSON.parse(await fs.readFile(values.fixture, 'utf8'));
    validateFixture(fixture, corpus.chunks);
    const namespace = values.namespace ?? corpus.namespace;
    if (namespace !== corpus.namespace) throw new Error('Namespace does not match current corpus; rebuild the candidate');
    const base = {
        version: 2, namespace, fixtureHash: fixtureHash(fixture), timestamp: new Date().toISOString(),
        embeddingModel: AI_CONFIG.embedding.model, indexName: AI_CONFIG.retrieval.indexName,
        topK: AI_CONFIG.retrieval.topK,
        maxContextChars: AI_CONFIG.retrieval.maxContextChars,
        promptHash: promptHash(),
    };
    if (command === 'validate' || values['dry-run']) {
        console.log(JSON.stringify({ ...base, models, cases: fixture.cases.length,
            maxGenerationCalls: command === 'compare'
                ? fixture.cases.length * models.length * repeats : 0,
            dryRun: true }, null, 2));
        return;
    }
    if (command === 'release-check') {
        if (!values['retrieval-report'] || !values['comparison-report']) {
            throw new Error('--retrieval-report and --comparison-report are required');
        }
        const report = JSON.parse(await fs.readFile(values['retrieval-report'], 'utf8'));
        validateRetrievalReport(report, { namespace, fixture, minHitRate });
        const wrangler = await fs.readFile('wrangler.toml', 'utf8');
        const vars = wrangler.split(/^\[vars\][ \t]*\r?$/m)[1]?.split(/^\[/m)[0] ?? '';
        const active = vars.match(/^AI_CORPUS_NAMESPACE\s*=\s*"([^"]+)"\s*$/m)?.[1];
        if (active !== namespace) throw new Error(`Set [vars] AI_CORPUS_NAMESPACE = "${namespace}" in wrangler.toml before deploying`);
        const modelName = vars.match(/^AI_MODEL\s*=\s*"([^"]+)"\s*$/m)?.[1];
        if (!modelName) throw new Error('Set [vars] AI_MODEL explicitly before deploying');
        const comparison = JSON.parse(await fs.readFile(values['comparison-report'], 'utf8'));
        validateComparisonReport(comparison, {
            namespace, fixture, model: getModel(modelName), minAnswerRate, retrievalReport: report,
        });
        console.log(`Release gate passed for ${namespace} (hit@${base.topK}: ${report.hitRate})`);
        return;
    }
    let report;
    if (command === 'retrieval') {
        const cloudflare = createCloudflareAi({ namespace, timeoutMs });
        report = { ...base, kind: 'retrieval', ...await evaluateRetrieval({
            cases: fixture.cases, retrieve: cloudflare.retrieve,
        }) };
    } else {
        let contexts;
        let retrievalHash;
        if (values['retrieval-report']) {
            const retrieval = JSON.parse(await fs.readFile(values['retrieval-report'], 'utf8'));
            validateRetrievalReport(retrieval, { namespace, fixture, minHitRate });
            retrievalHash = fixtureHash(retrieval);
            contexts = Object.fromEntries(retrieval.results.map(item => [item.caseId, item.context]));
        } else {
            contexts = Object.fromEntries(fixture.cases.map(item => [item.id, contextFromMatches(
                corpus.chunks.filter(chunk => item.expectedSources.includes(chunk.metadata.source))
                    .slice(0, AI_CONFIG.retrieval.topK).map(chunk => ({ metadata: chunk.metadata })),
            )]));
        }
        const cloudflare = createCloudflareAi({ namespace, timeoutMs });
        report = {
            ...base, kind: 'comparison', pricingDate: AI_CONFIG.pricingDate,
            contextMode: values['retrieval-report'] ? 'retrieved' : 'labeled-source',
            ...(retrievalHash ? { retrievalHash } : {}),
            modelConfigurations: Object.fromEntries(models.map(name => {
                const model = getModel(name);
                return [model.id, model];
            })),
            costScope: 'Estimated generation only; excludes embeddings, retries, storage and plan allowances',
            ...await compareModels({ cases: fixture.cases, models, contexts, run: cloudflare.run, repeats }),
        };
    }
    const output = values.output ?? `reports/ai-${command}.json`;
    await writeReport(output, report);
    console.log(JSON.stringify(report.summaries ?? { hitRate: report.hitRate }, null, 2));
    console.log(`Report: ${output}`);
    if (command === 'retrieval' && (report.hitRate < minHitRate || report.results.some(item => item.error))) {
        throw new Error('Retrieval evaluation failed; inspect the report');
    }
    if (command === 'compare' && report.results.some(item => item.status === 'error')) {
        throw new Error('One or more model calls failed; inspect the report');
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`AI evaluation failed: ${error.message}`);
        process.exitCode = 1;
    });
}
