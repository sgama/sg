import { z } from 'zod';
import { AI_CONFIG, getModel } from '../../../functions/_lib/application.js';
import { contextualizationMessages } from '../../../functions/_lib/prompts.js';
import { fixtureHash, promptHash } from './fixtures.mjs';
import { retrievalEvidenceRate, scoreAnswer, scoreRetrievalQuery } from './scoring.mjs';

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
