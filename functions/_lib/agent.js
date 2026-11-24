import { stepCountIs, streamText, tool } from 'ai';
import { createAISearchNamespace } from 'ai-search-provider';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import { AI_CONFIG, CONFIG, getModel } from '../../shared/ai/application.js';
import { isOutputPart, wireEvents } from '../../shared/ai/chat-stream.js';
import { searchOutput } from '../../shared/ai/evidence.js';
import { SYSTEM_PROMPT } from '../../shared/ai/prompts.js';
import { createResponseMetrics } from '../../shared/ai/response-metrics.js';

const { search, generation } = AI_CONFIG;

/** @typedef {{ query: string, ai_search_options: Record<string, unknown> }} SearchParams */
/** @typedef {{ search: (params: SearchParams) => Promise<{ chunks: import('../../shared/ai/evidence.js').Chunk[] }> }} SearchInstance */
/** @typedef {{ AI: unknown, AI_SEARCH: unknown, AI_SEARCH_INSTANCE?: string, AI_GATEWAY_ID?: string, AI_MODEL?: string }} TurnEnv */
/** @typedef {(model: import('../../shared/ai/application.js').Model) => import('@ai-sdk/provider').LanguageModelV3} LanguageModelFactory */

/**
 * The one tool the model has. The model sees only title and text; evidence (the public sources) rides along in the
 * tool output for the wire mapper and never reaches the model, so it cannot write links of its own.
 * @param {SearchInstance} instance
 */
export function searchPortfolioTool(instance) {
    return tool({
        description: "Search Samson's resume, portfolio projects and posts. Pass a standalone search query.",
        inputSchema: z.object({ query: z.string().trim().min(1).max(CONFIG.QUERY.MAX_LENGTH) }),
        execute: async ({ query }) => {
            const { chunks } = await instance.search({
                query,
                ai_search_options: {
                    retrieval: {
                        retrieval_type: 'hybrid',
                        max_num_results: search.maxResults,
                        match_threshold: search.matchThreshold,
                        context_expansion: search.contextExpansion,
                    },
                    reranking: { enabled: true, model: search.reranker },
                    cache: { enabled: true },
                },
            });
            return searchOutput(chunks, search.maxContextChars);
        },
        toModelOutput: ({ output }) => ({
            type: 'json',
            value: output.results.length ? output.results : { results: [], message: 'No matching content found.' },
        }),
    });
}

/** @param {string | undefined} preferred */
export function modelChain(preferred) {
    const names = [preferred ?? generation.defaultModel, ...generation.fallbackModels];
    return [...new Map(names.map((name) => [getModel(name).id, getModel(name)])).values()];
}

/**
 * Ends iteration with the signal's reason as soon as it aborts. streamText can stay silent forever when the abort
 * lands while a step is starting, and the request deadline must still end the turn.
 * @template T
 * @param {AsyncIterable<T>} source
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<T>}
 */
async function* abortable(source, signal) {
    if (!signal) return yield* source;
    const iterator = source[Symbol.asyncIterator]();
    const aborted = new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    aborted.catch(() => {});
    try {
        for (;;) {
            const next = await Promise.race([iterator.next(), aborted]);
            if (next.done) return;
            yield next.value;
        }
    } finally {
        void iterator.return?.();
    }
}

/**
 * Runs `attempt` on each model in turn. A failure before the attempt produced any output moves to the next model;
 * after output, or on the last model or an aborted signal, it is final. Yields a `{ type: 'model' }` part per attempt.
 * @template {{ type: string }} P
 * @param {import('../../shared/ai/application.js').Model[]} models
 * @param {(model: import('../../shared/ai/application.js').Model) => AsyncIterable<P>} attempt
 * @param {AbortSignal} [signal]
 * @returns {AsyncGenerator<P | { type: 'model', model: import('../../shared/ai/application.js').Model }>}
 */
export async function* runWithFallback(models, attempt, signal) {
    for (const [index, model] of models.entries()) {
        yield { type: 'model', model };
        let output = false;
        let failure;
        let failed = false;
        try {
            for await (const part of abortable(attempt(model), signal)) {
                if (part.type === 'error' && !output) {
                    failed = true;
                    failure = /** @type {{ error?: unknown }} */ (part).error;
                    break;
                }
                output ||= isOutputPart(part);
                yield part;
            }
        } catch (error) {
            if (output) throw error;
            failed = true;
            failure = error;
        }
        if (!failed) return;
        if (index === models.length - 1 || signal?.aborted) throw failure;
        console.error(`Model ${model.id} failed before output, trying the next model:`, failure);
    }
}

/**
 * One chat turn: the model decides whether to search, then answers. Yields the widget's wire events and throws on failure.
 * @param {{ env: TurnEnv, query: string, history: import('../../shared/ai/application.js').ChatMessage[], signal?: AbortSignal, languageModel?: LanguageModelFactory, instance?: SearchInstance }} turn
 */
export function runTurn({ env, query, history, signal, languageModel, instance }) {
    const workersAI = createWorkersAI({
        binding: /** @type {Parameters<typeof createWorkersAI>[0] extends { binding: infer B } ? B : never} */ (env.AI),
        ...(env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : {}),
    });
    const tools = {
        searchPortfolio: searchPortfolioTool(
            instance ??
                createAISearchNamespace({ binding: /** @type {Parameters<typeof createAISearchNamespace>[0]['binding']} */ (env.AI_SEARCH) }).get(
                    /** @type {string} */ (env.AI_SEARCH_INSTANCE),
                ),
        ),
    };
    const attempt = (/** @type {import('../../shared/ai/application.js').Model} */ model) =>
        streamText({
            model: languageModel ? languageModel(model) : workersAI(model.id, model.parameters),
            system: SYSTEM_PROMPT,
            messages: [...history, { role: 'user', content: query }],
            tools,
            // The last step must answer: a model still calling tools there would end the turn with no text.
            prepareStep: ({ stepNumber }) => (stepNumber >= generation.maxSteps - 1 ? { toolChoice: 'none' } : undefined),
            stopWhen: stepCountIs(generation.maxSteps),
            maxOutputTokens: generation.maxCompletionTokens,
            // Paid calls are never retried by the SDK; the model chain is the only retry.
            maxRetries: 0,
            abortSignal: signal,
            onError: () => {},
        }).fullStream;
    return wireEvents(runWithFallback(modelChain(env.AI_MODEL), attempt, signal), createResponseMetrics());
}
