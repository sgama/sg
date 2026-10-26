import { EventSourceParserStream } from 'eventsource-parser/stream';
import { AI_CONFIG, getModel, generationInput, estimateCost } from '../../../functions/_lib/application.js';
import { buildMessages } from '../../../functions/_lib/prompts.js';
import { contextFromMatches } from '../../../functions/_lib/retrieval.js';
import { normalizeChatStream } from '../../../functions/_lib/chat-stream.js';
import { SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext } from '../../../functions/_lib/validation.js';
import { percentile, retrievalEvidenceRate, scoreAnswer, scoreEvidence, scoreRetrievalQuery } from './scoring.mjs';

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
