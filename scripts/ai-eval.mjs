import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import 'dotenv/config';
import { AI_CONFIG, AI_MODELS, getModel } from '../functions/_lib/application.js';
import { contextualizationMessages } from '../functions/_lib/prompts.js';
import { contextFromMatches, expandSectionMatches } from '../functions/_lib/retrieval.js';
import { buildCorpus } from './lib/corpus.mjs';
import { createCloudflareAi } from './lib/cloudflare-ai.mjs';
import { runIfMain } from './lib/cli.mjs';
import {
    validateFixture,
    validateRetrievalReport,
    validateComparisonReport,
    promptHash,
    fixtureHash,
    evaluateRetrieval,
    compareModels,
} from './lib/ai-evaluation.mjs';

async function writeReport(output, report) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const COMMANDS = ['models', 'validate', 'retrieval', 'compare', 'release-check'];

function parseCommand(args) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
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
    if (positionals.length !== 1 || !COMMANDS.includes(command)) {
        throw new Error('Usage: ai-eval.mjs models|validate|retrieval|compare|release-check [options]');
    }
    const models = values.models.split(',').map((name) => name.trim());
    if (new Set(models).size !== models.length) throw new Error('Model names must be unique');
    for (const name of models) getModel(name);
    return { command, values, models };
}

function parseLimits(values) {
    const limits = {
        repeats: Number(values.repeats),
        minHitRate: Number(values['min-hit-rate']),
        minAnswerRate: Number(values['min-answer-rate']),
        timeoutMs: Number(values['timeout-ms']),
    };
    const rate = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
    if (!Number.isInteger(limits.repeats) || limits.repeats < 1 || limits.repeats > 20) throw new Error('repeats must be 1..20');
    if (!rate(limits.minHitRate)) throw new Error('min-hit-rate must be 0..1');
    if (!rate(limits.minAnswerRate)) throw new Error('min-answer-rate must be 0..1');
    if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1000 || limits.timeoutMs > 300000)
        throw new Error('timeout-ms must be 1000..300000');
    return limits;
}

/** Everything every evaluating command needs: validated limits, the current corpus, the fixture and the report header. */
async function prepare({ command, values, models }) {
    const limits = parseLimits(values);
    const corpus = await buildCorpus();
    const fixture = await readJson(values.fixture);
    validateFixture(fixture, corpus.chunks);
    const namespace = values.namespace ?? corpus.namespace;
    if (namespace !== corpus.namespace) throw new Error('Namespace does not match current corpus; rebuild the candidate');
    const base = {
        version: 2,
        namespace,
        fixtureHash: fixtureHash(fixture),
        timestamp: new Date().toISOString(),
        embeddingModel: AI_CONFIG.embedding.model,
        indexName: AI_CONFIG.retrieval.indexName,
        topK: AI_CONFIG.retrieval.topK,
        maxContextChars: AI_CONFIG.retrieval.maxContextChars,
        promptHash: promptHash(),
        contextualizationHash: fixtureHash(contextualizationMessages('__query__', [{ role: 'user', content: '__history__' }])),
        contextualizationModel: getModel(AI_CONFIG.contextualization.model).id,
        contextualizationMaxCompletionTokens: AI_CONFIG.contextualization.maxCompletionTokens,
        contextualizationMaxQueryChars: AI_CONFIG.contextualization.maxQueryChars,
    };
    return { command, values, models, ...limits, corpus, fixture, namespace, base };
}

function listModels() {
    console.log(JSON.stringify({ pricingDate: AI_CONFIG.pricingDate, models: AI_MODELS }, null, 2));
}

function printPlan({ command, models, repeats, fixture, base }) {
    const maxGenerationCalls = command === 'compare' ? fixture.cases.length * models.length * repeats : 0;
    console.log(JSON.stringify({ ...base, models, cases: fixture.cases.length, maxGenerationCalls, dryRun: true }, null, 2));
}

/** The deployable Wrangler settings: the active corpus namespace and the explicit answer model. */
async function wranglerVars() {
    const wrangler = await fs.readFile('wrangler.toml', 'utf8');
    const vars = wrangler.split(/^\[vars\][ \t]*\r?$/m)[1]?.split(/^\[/m)[0] ?? '';
    return {
        namespace: vars.match(/^AI_CORPUS_NAMESPACE\s*=\s*"([^"]+)"\s*$/m)?.[1],
        model: vars.match(/^AI_MODEL\s*=\s*"([^"]+)"\s*$/m)?.[1],
    };
}

async function releaseCheck({ values, fixture, namespace, minHitRate, minAnswerRate, base }) {
    if (!values['retrieval-report'] || !values['comparison-report']) {
        throw new Error('--retrieval-report and --comparison-report are required');
    }
    const report = await readJson(values['retrieval-report']);
    validateRetrievalReport(report, { namespace, fixture, minHitRate });
    const active = await wranglerVars();
    if (active.namespace !== namespace) throw new Error(`Set [vars] AI_CORPUS_NAMESPACE = "${namespace}" in wrangler.toml before deploying`);
    if (!active.model) throw new Error('Set [vars] AI_MODEL explicitly before deploying');
    const comparison = await readJson(values['comparison-report']);
    validateComparisonReport(comparison, { namespace, fixture, model: getModel(active.model), minAnswerRate, retrievalReport: report });
    console.log(`Release gate passed for ${namespace} (hit@${base.topK}: ${report.hitRate})`);
}

/** Answer contexts built from the labeled sources themselves (no retrieval), for comparing models in isolation. */
function labeledContexts(fixture, corpus) {
    const sections = corpus.chunks.filter((chunk) => chunk.metadata.recordType === 'section');
    return Object.fromEntries(
        fixture.cases.map((item) => {
            const hits = corpus.chunks
                .filter((chunk) => item.expectedSources.includes(chunk.metadata.source))
                .slice(0, AI_CONFIG.retrieval.topK)
                .map((chunk) => ({ id: chunk.id, metadata: chunk.metadata }));
            return [item.id, contextFromMatches(expandSectionMatches(hits, sections))];
        }),
    );
}

async function retrieval(run, { fetchImpl }) {
    const { fixture, namespace, timeoutMs, base } = run;
    const cloudflare = createCloudflareAi({ namespace, timeoutMs, fetchImpl });
    const report = { ...base, kind: 'retrieval', ...(await evaluateRetrieval({ cases: fixture.cases, retrieve: cloudflare.retrieve })) };
    await publish(run, report);
    const weak = report.hitRate < run.minHitRate || (report.evidenceRate !== null && report.evidenceRate < run.minHitRate);
    if (weak || report.results.some((item) => item.error)) throw new Error('Retrieval evaluation failed; inspect the report');
}

async function compare(run, { fetchImpl }) {
    const { values, fixture, corpus, namespace, models, repeats, timeoutMs, minHitRate, base } = run;
    let contexts;
    let retrievalHash;
    if (values['retrieval-report']) {
        const retrieved = await readJson(values['retrieval-report']);
        validateRetrievalReport(retrieved, { namespace, fixture, minHitRate });
        retrievalHash = fixtureHash(retrieved);
        contexts = Object.fromEntries(retrieved.results.map((item) => [item.caseId, item.context]));
    } else {
        contexts = labeledContexts(fixture, corpus);
    }
    const cloudflare = createCloudflareAi({ namespace, timeoutMs, fetchImpl });
    const report = {
        ...base,
        kind: 'comparison',
        pricingDate: AI_CONFIG.pricingDate,
        contextMode: values['retrieval-report'] ? 'retrieved' : 'labeled-source',
        ...(retrievalHash ? { retrievalHash } : {}),
        modelConfigurations: Object.fromEntries(models.map((name) => [getModel(name).id, getModel(name)])),
        costScope: 'Estimated answer generation only; excludes query contextualization, embeddings, retries, storage and plan allowances',
        ...(await compareModels({ cases: fixture.cases, models, contexts, run: cloudflare.run, repeats })),
    };
    await publish(run, report);
    if (report.results.some((item) => item.status === 'error')) throw new Error('One or more model calls failed; inspect the report');
}

/** Writes the report and prints its summary; callers then decide whether the results fail the command. */
async function publish({ command, values }, report) {
    const output = values.output ?? `reports/ai-${command}.json`;
    await writeReport(output, report);
    console.log(JSON.stringify(report.summaries ?? { hitRate: report.hitRate, evidenceRate: report.evidenceRate }, null, 2));
    console.log(`Report: ${output}`);
}

const HANDLERS = { 'release-check': releaseCheck, retrieval, compare };

export async function main(args = process.argv.slice(2), { fetchImpl = globalThis.fetch } = {}) {
    const parsed = parseCommand(args);
    if (parsed.command === 'models') return listModels();
    const run = await prepare(parsed);
    if (parsed.command === 'validate' || parsed.values['dry-run']) return printPlan(run);
    return HANDLERS[parsed.command](run, { fetchImpl });
}

runIfMain(import.meta.url, main, 'AI evaluation failed');
