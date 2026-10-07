import { createHash } from 'node:crypto';
import { AI_CONFIG, getModel, generationInput, contextFromMatches } from '../../functions/_lib/ai-config.js';
import { buildMessages } from '../../functions/_lib/config.js';
import { normalizeChatStream } from '../../functions/_lib/chat-stream.js';
import { SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext } from '../../functions/_lib/guardrails.js';

export function fixtureHash(fixture) {
    return createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
}

export function validateFixture(fixture, chunks) {
    if (!fixture || fixture.version !== 1 || !Array.isArray(fixture.cases) || !fixture.cases.length) {
        throw new Error('Evaluation fixture must have version 1 and nonempty cases');
    }
    const ids = new Set();
    const sources = new Set(chunks.map(chunk => chunk.metadata.source));
    for (const item of fixture.cases) {
        if (!item.id || ids.has(item.id) || typeof item.query !== 'string' || !item.query.trim()) {
            throw new Error('Evaluation cases need unique IDs and nonempty queries');
        }
        ids.add(item.id);
        if (item.required !== undefined && typeof item.required !== 'boolean') {
            throw new Error(`Invalid required flag for ${item.id}`);
        }
        if (!Array.isArray(item.expectedSources) || !Array.isArray(item.answerTerms)
            || !Array.isArray(item.forbiddenTerms) || !item.answerTerms.length
            || item.answerTerms.some(group => !Array.isArray(group) || !group.length
                || group.some(term => typeof term !== 'string' || !term))) {
            throw new Error(`Invalid labels for ${item.id}`);
        }
        for (const source of item.expectedSources) {
            if (!sources.has(source)) throw new Error(`Missing labeled source ${source}`);
        }
        if (item.forbiddenTerms.some(term => typeof term !== 'string' || !term)) {
            throw new Error(`Invalid forbidden terms for ${item.id}`);
        }
    }
}

export function scoreAnswer(answer, item) {
    const text = answer.toLowerCase();
    return item.answerTerms.every(group => group.some(term => text.includes(term.toLowerCase())))
        && !item.forbiddenTerms.some(term => text.includes(term.toLowerCase()));
}

export function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

export function estimateCost(usage, model) {
    if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens)
        || usage.prompt_tokens < 0 || usage.completion_tokens < 0) return null;
    return (usage.prompt_tokens * model.inputPerMillion
        + usage.completion_tokens * model.outputPerMillion) / 1e6;
}

export async function readAnswer(stream, { start, clock = () => performance.now() }) {
    const reader = normalizeChatStream(stream).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let usage = null;
    let firstAnswerMs = null;
    let lastAnswerMs = null;
    const chunkGapsMs = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop();
            for (const event of events) {
                const data = event.slice(6);
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
        }
        if (!answer.trim()) throw new Error('Model returned no answer');
    } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }
    return { answer, usage, ttftMs: firstAnswerMs, generationMs: clock() - start, chunkGapsMs };
}

export async function evaluateRetrieval({ cases, retrieve, clock = () => performance.now() }) {
    const results = [];
    for (const item of cases) {
        if (!item.expectedSources.length) continue;
        const start = clock();
        try {
            const { matches, embeddingMs, searchMs } = await retrieve(item.query);
            const sources = matches.map(match => match.metadata?.source).filter(Boolean);
            results.push({
                caseId: item.id,
                passed: item.expectedSources.some(source => sources.includes(source)),
                sources,
                matches: matches.map(match => ({ id: match.id, score: match.score, metadata: match.metadata })),
                context: contextFromMatches(matches),
                embeddingMs, searchMs, totalMs: clock() - start,
            });
        } catch (error) {
            results.push({ caseId: item.id, passed: false, error: error.message, totalMs: clock() - start });
        }
    }
    const hits = results.filter(item => item.passed).length;
    return { results, hitRate: results.length ? hits / results.length : 0 };
}

export async function compareModels({
    cases, models, contexts, run, repeats = 1, clock = () => performance.now(),
}) {
    const results = [];
    // Interleave models within each case to reduce ordering bias. Keep concurrency bounded at one.
    for (let repeat = 0; repeat < repeats; repeat++) {
        for (const item of cases) {
            const context = contexts[item.id];
            if (typeof context !== 'string') throw new Error(`Missing context for ${item.id}`);
            for (const name of models) {
                const model = getModel(name);
                const start = clock();
                try {
                    const abstain = shouldAbstainForMissingContext(context);
                    const output = abstain
                        ? { answer: SAFE_NO_CONTEXT_MESSAGE, usage: null, ttftMs: null, generationMs: 0, chunkGapsMs: [] }
                        : await readAnswer(
                            await run(model.id, generationInput(model, buildMessages(item.query, context))),
                            { start, clock },
                        );
                    const cost = abstain ? 0 : estimateCost(output.usage, model);
                    results.push({
                        caseId: item.id, model: name, modelId: model.id, repeat,
                        status: 'ok', abstained: abstain, passed: scoreAnswer(output.answer, item),
                        ...output, estimatedGenerationCostUsd: cost,
                        completionTokensPerGenerationSecond: output.usage?.completion_tokens != null && output.generationMs > 0
                            ? output.usage.completion_tokens / (output.generationMs / 1000) : null,
                    });
                } catch (error) {
                    results.push({ caseId: item.id, model: name, modelId: model.id, repeat,
                        status: 'error', passed: false, error: error.message, generationMs: clock() - start });
                }
            }
        }
    }
    const summaries = models.map(name => {
        const samples = results.filter(item => item.model === name);
        const generated = samples.filter(item => item.status === 'ok' && !item.abstained);
        const costs = generated.map(item => item.estimatedGenerationCostUsd);
        return {
            model: name, requests: samples.length,
            successRate: samples.filter(item => item.status === 'ok').length / samples.length,
            answerCheckRate: samples.filter(item => item.passed).length / samples.length,
            ttftP50Ms: percentile(generated.map(item => item.ttftMs), 0.5),
            ttftP95Ms: percentile(generated.map(item => item.ttftMs), 0.95),
            generationP95Ms: percentile(generated.map(item => item.generationMs), 0.95),
            interChunkP95Ms: percentile(generated.flatMap(item => item.chunkGapsMs), 0.95),
            estimatedGenerationCostUsd: samples.every(item => item.status === 'ok') && costs.every(cost => cost !== null)
                ? costs.reduce((sum, cost) => sum + cost, 0) : null,
            usageCoverage: generated.length ? costs.filter(cost => cost !== null).length / generated.length : null,
            costComplete: samples.every(item => item.status === 'ok')
                && costs.every(cost => cost !== null),
        };
    });
    return { results, summaries, maxCompletionTokens: AI_CONFIG.generation.maxCompletionTokens };
}
