import { createHash } from 'node:crypto';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { z } from 'zod';
import { AI_CONFIG, getModel, generationInput, estimateCost } from '../../functions/_lib/application.js';
import { buildMessages, contextualizationMessages } from '../../functions/_lib/prompts.js';
import { contextFromMatches } from '../../functions/_lib/retrieval.js';
export { estimateCost } from '../../functions/_lib/application.js';
import { normalizeChatStream } from '../../functions/_lib/chat-stream.js';
import { SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext } from '../../functions/_lib/validation.js';

export function fixtureHash(fixture) {
    return createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
}

const ID_ERROR = 'Evaluation cases need unique IDs and nonempty queries';
const present = (value) => value.trim().length > 0;
const label = z.string().refine(present); // a term that is not blank
const exact = z.string().min(1); // an answer or forbidden term, kept as written
const groupsOf = (term) => z.array(z.array(term).min(1)).min(1);
const turn = z.object({ role: z.enum(['user', 'assistant']), content: z.string().refine(present).max(2000) });
const FixtureCase = z
    .object({
        id: z.string().min(1),
        query: z.string().refine(present),
        evidenceTerms: groupsOf(label).optional(),
        required: z.boolean().optional(),
        history: z.array(turn).max(4).optional(),
        retrievalTerms: groupsOf(label).optional(),
        expectedSources: z.array(z.string()),
        answerTerms: groupsOf(exact),
        forbiddenTerms: z.array(exact),
    })
    .superRefine((item, ctx) => {
        const fail = (path) => ctx.addIssue({ code: 'custom', path: [path], message: path });
        if (item.evidenceTerms && !item.expectedSources.length) fail('evidenceTerms');
        if (item.history && item.history.reduce((sum, message) => sum + message.content.length, 0) > 4000) fail('history');
        if (item.retrievalTerms && !item.history?.length) fail('retrievalTerms');
    });
// Which label problem each field reports; id and query problems share one message.
const CASE_PROBLEMS = {
    evidenceTerms: 'evidence labels',
    required: 'required flag',
    history: 'conversation history',
    retrievalTerms: 'retrieval query labels',
    expectedSources: 'labels',
    answerTerms: 'labels',
    forbiddenTerms: 'forbidden terms',
};

export function validateFixture(fixture, chunks) {
    if (!fixture || fixture.version !== 1 || !Array.isArray(fixture.cases) || !fixture.cases.length) {
        throw new Error('Evaluation fixture must have version 1 and nonempty cases');
    }
    const sources = new Set(chunks.map((chunk) => chunk.metadata.source));
    const ids = new Set();
    for (const item of fixture.cases) {
        const parsed = FixtureCase.safeParse(item);
        if (!parsed.success) {
            const problem = CASE_PROBLEMS[parsed.error.issues[0].path[0]];
            throw new Error(problem ? `Invalid ${problem} for ${item.id}` : ID_ERROR);
        }
        if (ids.has(item.id)) throw new Error(ID_ERROR);
        ids.add(item.id);
        for (const source of item.expectedSources) {
            if (!sources.has(source)) throw new Error(`Missing labeled source ${source}`);
        }
    }
}

export function scoreAnswer(answer, item) {
    const text = answer.toLowerCase();
    return (
        item.answerTerms.every((group) => group.some((term) => text.includes(term.toLowerCase()))) &&
        !item.forbiddenTerms.some((term) => text.includes(term.toLowerCase()))
    );
}

export function scoreEvidence(context, item) {
    if (!item.evidenceTerms) return null;
    const text = context.replace(/^Source: \{[^\n]*\}\r?\n/gm, '').toLowerCase();
    return item.evidenceTerms.every((group) => group.some((term) => text.includes(term.toLowerCase())));
}

export function scoreRetrievalQuery(query, item) {
    if (!item.retrievalTerms) return null;
    const text = query.toLowerCase();
    return item.retrievalTerms.every((group) => group.some((term) => text.includes(term.toLowerCase())));
}

export function retrievalEvidenceRate(results, cases) {
    const labeled = cases.filter((item) => item.evidenceTerms);
    if (!labeled.length) return null;
    return (
        labeled.filter((item) => {
            const result = results.find((result) => result.caseId === item.id);
            return result && !result.error && typeof result.context === 'string' && scoreEvidence(result.context, item);
        }).length / labeled.length
    );
}

export function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function validUsage(usage) {
    return Boolean(
        usage &&
        Number.isFinite(usage.prompt_tokens) &&
        Number.isFinite(usage.completion_tokens) &&
        usage.prompt_tokens >= 0 &&
        usage.completion_tokens >= 0,
    );
}

export async function readAnswer(stream, { start, clock = () => performance.now() }) {
    // The widget's own SSE (answer, usage, metrics): framing by eventsource-parser. Leaving the loop early or on error
    // cancels the source stream.
    const events = normalizeChatStream(stream).pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream());
    let answer = '';
    let usage = null;
    let firstAnswerMs = null;
    let lastAnswerMs = null;
    const chunkGapsMs = [];
    for await (const { data } of events) {
        if (data === '[DONE]') continue;
        const payload = JSON.parse(data);
        if (payload.error) throw new Error(payload.error);
        if (payload.response) {
            const elapsed = clock() - start;
            if (firstAnswerMs === null) firstAnswerMs = elapsed;
            if (lastAnswerMs !== null) chunkGapsMs.push(elapsed - lastAnswerMs);
            lastAnswerMs = elapsed;
            answer += payload.response;
        }
        if (payload.usage) usage = payload.usage;
    }
    if (!answer.trim()) throw new Error('Model returned no answer');
    return { answer, usage, ttftMs: firstAnswerMs, generationMs: clock() - start, chunkGapsMs };
}

export async function evaluateRetrieval({ cases, retrieve, clock = () => performance.now() }) {
    const results = [];
    for (const item of cases) {
        const start = clock();
        try {
            const { matches, embeddingMs, searchMs, retrievalQuery = item.query } = await retrieve(item.query, item.history ?? []);
            const sources = matches.map((match) => match.metadata?.source).filter(Boolean);
            const context = contextFromMatches(matches);
            results.push({
                caseId: item.id,
                retrievalQuery,
                retrievalQueryPassed: scoreRetrievalQuery(retrievalQuery, item),
                passed: item.expectedSources.length ? item.expectedSources.some((source) => sources.includes(source)) : null,
                sources,
                matches: matches.map((match) => ({
                    id: match.id,
                    score: match.score,
                    metadata: match.metadata,
                })),
                context,
                evidencePassed: scoreEvidence(context, item),
                embeddingMs,
                searchMs,
                totalMs: clock() - start,
            });
        } catch (error) {
            results.push({
                caseId: item.id,
                passed: false,
                error: error.message,
                totalMs: clock() - start,
            });
        }
    }
    const positives = results.filter((result) => cases.find((item) => item.id === result.caseId).expectedSources.length);
    const hits = positives.filter((item) => item.passed).length;
    const rewriteCases = results.filter((result) => result.retrievalQueryPassed !== null);
    return {
        results,
        hitRate: positives.length ? hits / positives.length : 0,
        evidenceRate: retrievalEvidenceRate(results, cases),
        rewriteRate: rewriteCases.length ? rewriteCases.filter((item) => item.retrievalQueryPassed).length / rewriteCases.length : null,
    };
}

export async function compareModels({ cases, models, contexts, run, repeats = 1, clock = () => performance.now(), resolveModel = getModel }) {
    const results = [];
    // Interleave models within each case to reduce ordering bias. Keep concurrency bounded at one.
    for (let repeat = 0; repeat < repeats; repeat++) {
        for (const item of cases) {
            const context = contexts[item.id];
            if (typeof context !== 'string') throw new Error(`Missing context for ${item.id}`);
            for (const name of models) {
                const model = resolveModel(name);
                const start = clock();
                try {
                    const abstain = shouldAbstainForMissingContext(context);
                    const output = abstain
                        ? {
                              answer: SAFE_NO_CONTEXT_MESSAGE,
                              usage: null,
                              ttftMs: null,
                              generationMs: 0,
                              chunkGapsMs: [],
                          }
                        : await readAnswer(await run(model.id, generationInput(model, buildMessages(item.query, context, item.history ?? []))), {
                              start,
                              clock,
                          });
                    const cost = abstain ? 0 : estimateCost(output.usage, model);
                    results.push({
                        caseId: item.id,
                        model: name,
                        modelId: model.id,
                        repeat,
                        status: 'ok',
                        abstained: abstain,
                        passed: scoreAnswer(output.answer, item),
                        ...output,
                        estimatedGenerationCostUsd: cost,
                        completionTokensPerGenerationSecond:
                            output.usage?.completion_tokens != null && output.generationMs > 0
                                ? output.usage.completion_tokens / (output.generationMs / 1000)
                                : null,
                    });
                } catch (error) {
                    results.push({
                        caseId: item.id,
                        model: name,
                        modelId: model.id,
                        repeat,
                        status: 'error',
                        passed: false,
                        error: error.message,
                        generationMs: clock() - start,
                    });
                }
            }
        }
    }
    const summaries = models.map((name) => {
        const samples = results.filter((item) => item.model === name);
        const generated = samples.filter((item) => item.status === 'ok' && !item.abstained);
        const costs = generated.map((item) => item.estimatedGenerationCostUsd);
        return {
            model: name,
            requests: samples.length,
            successRate: samples.filter((item) => item.status === 'ok').length / samples.length,
            answerCheckRate: samples.filter((item) => item.passed).length / samples.length,
            ttftP50Ms: percentile(
                generated.map((item) => item.ttftMs),
                0.5,
            ),
            ttftP95Ms: percentile(
                generated.map((item) => item.ttftMs),
                0.95,
            ),
            generationP95Ms: percentile(
                generated.map((item) => item.generationMs),
                0.95,
            ),
            interChunkP95Ms: percentile(
                generated.flatMap((item) => item.chunkGapsMs),
                0.95,
            ),
            estimatedGenerationCostUsd:
                samples.every((item) => item.status === 'ok') && costs.every((cost) => cost !== null)
                    ? costs.reduce((sum, cost) => sum + cost, 0)
                    : null,
            usageCoverage: generated.length ? generated.filter((item) => validUsage(item.usage)).length / generated.length : null,
            costComplete: samples.every((item) => item.status === 'ok') && costs.every((cost) => cost !== null),
        };
    });
    return { results, summaries, maxCompletionTokens: AI_CONFIG.generation.maxCompletionTokens };
}

export const promptHash = () => fixtureHash(buildMessages('__query__', '__context__'));

// A retrieval report's shape and the settings it was produced under, checked against what this release expects.
const retrievalHeader = ({ namespace, fixture, minHitRate }) =>
    z.object({
        version: z.literal(2),
        kind: z.literal('retrieval'),
        namespace: z.literal(namespace),
        fixtureHash: z.literal(fixtureHash(fixture)),
        hitRate: z.number().min(minHitRate),
        topK: z.literal(AI_CONFIG.retrieval.topK),
        embeddingModel: z.literal(AI_CONFIG.embedding.model),
        maxContextChars: z.literal(AI_CONFIG.retrieval.maxContextChars),
        indexName: z.literal(AI_CONFIG.retrieval.indexName),
        contextualizationModel: z.literal(getModel(AI_CONFIG.contextualization.model).id),
        contextualizationMaxCompletionTokens: z.literal(AI_CONFIG.contextualization.maxCompletionTokens),
        contextualizationMaxQueryChars: z.literal(AI_CONFIG.contextualization.maxQueryChars),
        contextualizationHash: z.literal(fixtureHash(contextualizationMessages('__query__', [{ role: 'user', content: '__history__' }]))),
        results: z.array(z.any()),
    });

function assertSuccessfulResults(results, cases) {
    if (results.length !== cases.length) throw new Error('Retrieval report is incomplete');
    for (const item of cases) {
        const matches = results.filter((result) => result.caseId === item.id);
        if (matches.length !== 1 || matches[0].error || typeof matches[0].context !== 'string') {
            throw new Error(`Retrieval report missing successful query ${item.id}`);
        }
    }
}

function assertSourceHitRate(report, cases, minHitRate) {
    const positives = cases.filter((item) => item.expectedSources.length);
    const hits = report.results.filter((result) => {
        const item = cases.find((entry) => entry.id === result.caseId);
        return Array.isArray(result.sources) && item.expectedSources.some((source) => result.sources.includes(source));
    });
    const actual = hits.length / positives.length;
    if (!Number.isFinite(actual) || actual < minHitRate || actual !== report.hitRate) {
        throw new Error('Retrieval report source labels do not meet the release gate');
    }
}

function assertEvidenceRate(report, cases, minHitRate) {
    const rate = retrievalEvidenceRate(report.results, cases);
    if (rate !== null && (rate < minHitRate || report.evidenceRate !== rate)) {
        throw new Error('Retrieval report evidence does not meet the release gate');
    }
}

function assertContextualization(report, cases, minHitRate) {
    const labeled = cases.filter((item) => item.retrievalTerms);
    const passing = report.results.filter((result) => {
        const item = labeled.find((candidate) => candidate.id === result.caseId);
        return item && typeof result.retrievalQuery === 'string' && scoreRetrievalQuery(result.retrievalQuery, item);
    });
    const rate = labeled.length ? passing.length / labeled.length : null;
    if ((labeled.length && (!Number.isFinite(report.rewriteRate) || report.rewriteRate < minHitRate)) || report.rewriteRate !== rate) {
        throw new Error('Retrieval report contextualization does not meet the release gate');
    }
    for (const item of labeled) {
        const result = report.results.find((entry) => entry.caseId === item.id);
        if (
            typeof result.retrievalQuery !== 'string' ||
            !result.retrievalQuery.trim() ||
            result.retrievalQueryPassed !== scoreRetrievalQuery(result.retrievalQuery, item)
        ) {
            throw new Error(`Retrieval report has an invalid contextualized query for ${item.id}`);
        }
    }
}

export function validateRetrievalReport(report, options) {
    const { fixture, minHitRate } = options;
    if (!retrievalHeader(options).safeParse(report).success) {
        throw new Error('Retrieval report does not pass this corpus/fixture release gate');
    }
    assertSuccessfulResults(report.results, fixture.cases);
    assertSourceHitRate(report, fixture.cases, minHitRate);
    assertEvidenceRate(report, fixture.cases, minHitRate);
    assertContextualization(report, fixture.cases, minHitRate);
}

const comparisonHeader = ({ namespace, fixture, model }) =>
    z
        .object({
            kind: z.literal('comparison'),
            namespace: z.literal(namespace),
            fixtureHash: z.literal(fixtureHash(fixture)),
            promptHash: z.literal(promptHash()),
            contextMode: z.literal('retrieved'),
            maxCompletionTokens: z.literal(AI_CONFIG.generation.maxCompletionTokens),
            results: z.array(z.any()),
            modelConfigurations: z.record(z.string(), z.any()),
        })
        .refine((report) => JSON.stringify(report.modelConfigurations[model.id]) === JSON.stringify(model));

function assertSuccessfulAnswers(samples, repeats, cases) {
    for (const repeat of repeats) {
        for (const item of cases) {
            const entries = samples.filter((sample) => sample.caseId === item.id && sample.repeat === repeat);
            if (entries.length !== 1 || entries[0].status !== 'ok' || typeof entries[0].answer !== 'string') {
                throw new Error(`Comparison report missing successful answer for ${item.id}`);
            }
            if (item.required && !scoreAnswer(entries[0].answer, item)) {
                throw new Error(`Required answer regression failed for ${item.id} (repeat ${repeat})`);
            }
        }
    }
}

export function validateComparisonReport(report, options) {
    const { fixture, model, minAnswerRate, retrievalReport } = options;
    if (!comparisonHeader(options).safeParse(report).success) {
        throw new Error('Comparison report does not match the selected model, prompt and retrieved corpus');
    }
    if (!retrievalReport || report.retrievalHash !== fixtureHash(retrievalReport)) {
        throw new Error('Comparison report must use the current validated retrieval report');
    }
    const samples = report.results.filter((item) => item.modelId === model.id);
    const repeats = new Set(samples.map((item) => item.repeat));
    if (!repeats.size || [...repeats].some((repeat) => !Number.isInteger(repeat) || repeat < 0)) {
        throw new Error('Comparison report has no valid repetitions for selected model');
    }
    assertSuccessfulAnswers(samples, repeats, fixture.cases);
    if (samples.length !== repeats.size * fixture.cases.length) throw new Error('Unexpected comparison samples');
    const passing = samples.filter((sample) =>
        scoreAnswer(
            sample.answer,
            fixture.cases.find((item) => item.id === sample.caseId),
        ),
    );
    const rate = passing.length / samples.length;
    if (rate < minAnswerRate) throw new Error(`Selected model answer checks ${rate} below ${minAnswerRate}`);
}
