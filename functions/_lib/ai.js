import { AI_CONFIG, CONFIG, generationInput, getModel, isValidEmbeddingVector, rewriteSearchQuery } from '../../shared/ai/application.js';
import { buildMessages } from '../../shared/ai/prompts.js';
import { retrieveEvidence } from '../../shared/ai/retrieval.js';
import { normalizeChatStream } from '../../shared/ai/chat-stream.js';
import { createResponseMetrics } from '../../shared/ai/response-metrics.js';
import { AppError, requireVectorizeBinding } from './worker-errors.js';
import { isValidRetrievalCachePayload } from './retrieval-cache.js';

export class AiService {
    constructor(env, { retrievalStore = null, signal = undefined, deadlineSignal = undefined } = {}) {
        this.ai = env.AI;
        this.vectorize = env.VECTORIZE_INDEX;
        this.namespace = env.AI_CORPUS_NAMESPACE;
        // Options for every model call: AI Gateway routing (analytics, logs, retries) when configured, and the request's
        // abort signal so a closed tab or deadline stops paid rewrite, embedding and generation calls.
        this.runOptions = { ...(env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : {}), ...(signal ? { signal } : {}) };
        this.deadlineSignal = deadlineSignal;
        this.model = getModel(env.AI_MODEL);
        this.contextualizationModel = getModel(AI_CONFIG.contextualization.model);
        this.metrics = createResponseMetrics({ model: this.model, rewriteModel: this.contextualizationModel });
        // Optional store (see retrieval-cache.js); null disables retrieval caching.
        this.retrievalStore = retrievalStore;
    }

    /** Runs one upstream step: client aborts and AppErrors pass through, anything else is logged and reported as a 503. */
    async #guard(label, publicMessage, step) {
        try {
            return await step();
        } catch (err) {
            if (err instanceof AppError || this.runOptions.signal?.aborted) throw err;
            console.error(`${label} Failed:`, err);
            throw new AppError(publicMessage, 503);
        }
    }

    getEmbeddings(text) {
        return this.#guard('Embedding Generation', 'Embedding service unavailable', async () => {
            const { data } = await this.ai.run(AI_CONFIG.embedding.model, { text: [text] }, this.runOptions);
            const vector = data?.[0];
            if (!isValidEmbeddingVector(vector, AI_CONFIG.embedding.dimensions)) throw new Error('Invalid embedding response');
            return vector;
        });
    }

    async contextualizeQuery(query, history = []) {
        if (!history.length) return query;
        const begun = this.metrics.startRewrite();
        return this.#guard('Query Contextualization', 'Query contextualization service unavailable', () =>
            rewriteSearchQuery(query, history, this.contextualizationModel, async (modelId, input) => {
                const response = await this.ai.run(modelId, input, this.runOptions);
                this.metrics.rewrite({ begun, usage: response?.usage });
                return response;
            }),
        );
    }

    /**
     * Retrieval for one question: returns the bounded context and the public evidence it came from.
     * Stateless per call (no evidence kept on the instance); only timings feed the response metrics.
     */
    async retrieve(query, history = [], onProgress = /** @type {(stage: string) => Promise<void>} */ (async () => {})) {
        requireVectorizeBinding(this.vectorize);

        // Keyed by the question as asked plus the history it is read in, so a hit skips the rewrite call too.
        const cacheQuery = history.length ? `${query}\u0000${JSON.stringify(history)}` : query;
        const cached = this.retrievalStore ? await this.retrievalStore.get(this.namespace, cacheQuery) : null;
        if (isValidRetrievalCachePayload(cached)) {
            this.metrics.resetTiming('retrievalMs');
            await onProgress('search');
            return { contextText: cached.contextText, evidence: cached.evidence.map((item) => ({ ...item })) };
        }

        if (history.length) await onProgress('rewrite');
        const retrievalQuery = await this.contextualizeQuery(query, history);

        const result = await this.#guard('Vector Search', 'Retrieval service unavailable', () =>
            retrieveEvidence({
                retrievalQuery,
                namespace: this.namespace,
                embed: async (text) => {
                    await onProgress('embedding');
                    return this.metrics.time('embeddingMs', () => this.getEmbeddings(text));
                },
                search: async (vector) => {
                    await onProgress('search');
                    return this.metrics.time('retrievalMs', async () => {
                        const results = await this.vectorize.query(vector, {
                            topK: AI_CONFIG.retrieval.topK,
                            returnMetadata: 'all',
                            ...(this.namespace ? { namespace: this.namespace } : {}),
                        });
                        return results.matches;
                    });
                },
                fetchSections: (ids) => this.metrics.time('retrievalMs', () => this.vectorize.getByIds(ids)),
            }),
        );

        // Only non-empty contexts are cached. The store never rejects, so the write cannot fail the request.
        if (this.retrievalStore && result.contextText.trim().length >= CONFIG.ABSTAIN.MIN_CONTEXT_CHARS) {
            await this.retrievalStore.put(this.namespace, cacheQuery, {
                contextText: result.contextText,
                evidence: result.evidence,
            });
        }
        return { contextText: result.contextText, evidence: result.evidence };
    }

    responseMetrics(options) {
        return this.metrics.snapshot(options);
    }

    async generateStream(query, contextText, history = []) {
        const messages = buildMessages(query, contextText, history);
        return this.#guard('Generation', 'Generation service unavailable', async () =>
            normalizeChatStream(await this.ai.run(this.model.id, generationInput(this.model, messages), this.runOptions), {
                onFirstToken: () => this.metrics.firstToken(),
                onUsage: (usage) => this.metrics.generationUsed(usage),
                metrics: () => this.responseMetrics(),
                signal: this.runOptions.signal,
                deadlineSignal: this.deadlineSignal,
            }),
        );
    }
}
