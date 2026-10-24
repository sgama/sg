import {
    AI_CONFIG,
    AppError,
    CONFIG,
    contextualizationInput,
    contextualizedQueryFromResponse,
    getModel,
    generationInput,
    estimateCost,
} from './application.js';
import { buildMessages } from './prompts.js';
import { retrieveEvidence } from './retrieval-pipeline.js';
import { normalizeChatStream } from './chat-stream.js';

export class AiService {
    constructor(env, { retrievalStore = null } = {}) {
        this.ai = env.AI;
        this.vectorize = env.VECTORIZE_INDEX;
        this.namespace = env.AI_CORPUS_NAMESPACE;
        this.model = getModel(env.AI_MODEL);
        this.contextualizationModel = getModel(AI_CONFIG.contextualization.model);
        this.started = performance.now();
        this.timings = { rewriteMs: 0, embeddingMs: 0, retrievalMs: 0 };
        this.rewriteUsed = false;
        this.rewriteUsage = null;
        this.generationUsage = null;
        this.firstTokenMs = null;
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
        this.rewriteUsed = true;
        const start = performance.now();
        try {
            const response = await this.ai.run(this.contextualizationModel.id, contextualizationInput(this.contextualizationModel, query, history));
            this.timings.rewriteMs = performance.now() - start;
            this.rewriteUsage = response?.usage ?? null;
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
            this.timings.retrievalMs = 0;
            await onProgress('search');
            return { contextText: cached.contextText, evidence: cached.evidence.map((item) => ({ ...item })) };
        }

        const timed = async (key, work) => {
            const started = performance.now();
            try {
                return await work();
            } finally {
                this.timings[key] += performance.now() - started;
            }
        };
        let result;
        try {
            result = await retrieveEvidence({
                retrievalQuery,
                namespace: this.namespace,
                embed: async (text) => {
                    await onProgress('embedding');
                    return timed('embeddingMs', () => this.getEmbeddings(text));
                },
                search: async (vector) => {
                    await onProgress('search');
                    return timed('retrievalMs', async () => {
                        const results = await this.vectorize.query(vector, {
                            topK: AI_CONFIG.retrieval.topK,
                            returnMetadata: 'all',
                            ...(this.namespace ? { namespace: this.namespace } : {}),
                        });
                        return results.matches;
                    });
                },
                fetchSections: (ids) => timed('retrievalMs', () => this.vectorize.getByIds(ids)),
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

    responseMetrics({ abstained = false } = {}) {
        const generationCost = abstained ? 0 : estimateCost(this.generationUsage, this.model);
        const rewriteCost = this.rewriteUsed ? estimateCost(this.rewriteUsage, this.contextualizationModel) : 0;
        return {
            ...Object.fromEntries(Object.entries(this.timings).map(([key, value]) => [key, Math.round(value)])),
            totalMs: Math.round(performance.now() - this.started),
            firstTokenMs: this.firstTokenMs === null ? null : Math.round(this.firstTokenMs),
            generationModel: abstained ? null : this.model.id,
            generationUsage: this.generationUsage,
            rewriteUsage: this.rewriteUsage,
            rewriteUsed: this.rewriteUsed,
            estimatedLlmCostUsd: generationCost === null || rewriteCost === null ? null : generationCost + rewriteCost,
            pricingDate: AI_CONFIG.pricingDate,
            abstained,
        };
    }

    async generateStream(query, contextText, history = []) {
        const messages = buildMessages(query, contextText, history);
        try {
            const stream = await this.ai.run(this.model.id, generationInput(this.model, messages));
            return normalizeChatStream(stream, {
                onFirstToken: () => {
                    this.firstTokenMs = performance.now() - this.started;
                },
                onUsage: (usage) => {
                    this.generationUsage = usage;
                },
                metrics: () => this.responseMetrics(),
            });
        } catch (err) {
            console.error('Generation Failed:', err);
            throw new AppError('Generation service unavailable', 503);
        }
    }
}
