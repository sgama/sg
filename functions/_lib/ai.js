import { AI_CONFIG, AppError, CONFIG, contextualizationInput, contextualizedQueryFromResponse, getModel, generationInput } from './application.js';
import { buildMessages } from './prompts.js';
import { retrieveEvidence } from './retrieval.js';
import { normalizeChatStream } from './chat-stream.js';
import { createResponseMetrics } from './response-metrics.js';

export class AiService {
    constructor(env, { retrievalStore = null } = {}) {
        this.ai = env.AI;
        this.vectorize = env.VECTORIZE_INDEX;
        this.namespace = env.AI_CORPUS_NAMESPACE;
        this.model = getModel(env.AI_MODEL);
        this.contextualizationModel = getModel(AI_CONFIG.contextualization.model);
        this.metrics = createResponseMetrics({ model: this.model, rewriteModel: this.contextualizationModel });
        // Optional store (see retrieval-cache.js); null disables retrieval caching.
        this.retrievalStore = retrievalStore;
    }

    async getEmbeddings(text) {
        try {
            const { data } = await this.ai.run(AI_CONFIG.embedding.model, { text: [text] });
            const vector = data?.[0];
            if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) {
                throw new Error('Invalid embedding response');
            }
            return vector;
        } catch (err) {
            console.error('Embedding Generation Failed:', err);
            throw new AppError('Embedding service unavailable', 503);
        }
    }

    async contextualizeQuery(query, history = []) {
        if (!history.length) return query;
        const begun = this.metrics.startRewrite();
        try {
            const response = await this.ai.run(this.contextualizationModel.id, contextualizationInput(this.contextualizationModel, query, history));
            this.metrics.rewrite({ begun, usage: response?.usage });
            return contextualizedQueryFromResponse(response);
        } catch (err) {
            console.error('Query Contextualization Failed:', err);
            throw new AppError('Query contextualization service unavailable', 503);
        }
    }

    /**
     * Retrieval for one question: returns the bounded context and the public evidence it came from.
     * Stateless per call (no evidence kept on the instance); only timings feed the response metrics.
     */
    async retrieve(query, history = [], onProgress = async () => {}) {
        if (!this.vectorize) {
            console.error('Vector Search Failed: VECTORIZE_INDEX binding missing');
            throw new AppError('Retrieval service unavailable', 503);
        }

        if (history.length) await onProgress('rewrite');
        const retrievalQuery = await this.contextualizeQuery(query, history);

        // Deterministic for a given corpus namespace and query, so repeat questions skip paid calls.
        const cached = this.retrievalStore ? await this.retrievalStore.get(this.namespace, retrievalQuery) : null;
        if (cached) {
            this.metrics.resetTiming('retrievalMs');
            await onProgress('search');
            return { contextText: cached.contextText, evidence: cached.evidence.map((item) => ({ ...item })) };
        }

        let result;
        try {
            result = await retrieveEvidence({
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
            });
        } catch (err) {
            if (err instanceof AppError) throw err;
            console.error('Vector Search Failed:', err);
            throw new AppError('Retrieval service unavailable', 503);
        }

        // Only non-empty contexts are cached. The store never rejects, so the write cannot fail the request.
        if (this.retrievalStore && result.contextText.trim().length >= CONFIG.ABSTAIN.MIN_CONTEXT_CHARS) {
            await this.retrievalStore.put(this.namespace, retrievalQuery, {
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
        try {
            const stream = await this.ai.run(this.model.id, generationInput(this.model, messages));
            return normalizeChatStream(stream, {
                onFirstToken: () => this.metrics.firstToken(),
                onUsage: (usage) => this.metrics.generationUsed(usage),
                metrics: () => this.responseMetrics(),
            });
        } catch (err) {
            console.error('Generation Failed:', err);
            throw new AppError('Generation service unavailable', 503);
        }
    }
}
