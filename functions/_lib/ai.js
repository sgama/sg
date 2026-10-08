import {
    AI_CONFIG,
    AppError,
    buildMessages,
    contextualizationInput,
    contextualizedQueryFromResponse,
    getModel,
    generationInput,
    contextFromMatches,
    parentSectionIds,
    expandSectionMatches,
    estimateCost,
} from './application.js';
import { normalizeChatStream } from './chat-stream.js';

export class AiService {
    constructor(env) {
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
        this.evidence = [];
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

    async retrieveContext(query, history = [], onProgress = async () => {}) {
        if (!this.vectorize) {
            console.error('Vector Search Failed: VECTORIZE_INDEX binding missing');
            throw new AppError('Retrieval service unavailable', 503);
        }

        if (history.length) await onProgress('rewrite');
        const retrievalQuery = await this.contextualizeQuery(query, history);
        await onProgress('embedding');
        const embeddingStart = performance.now();
        const vector = await this.getEmbeddings(retrievalQuery);
        this.timings.embeddingMs = performance.now() - embeddingStart;

        try {
            await onProgress('search');
            const searchStart = performance.now();
            const results = await this.vectorize.query(vector, {
                topK: AI_CONFIG.retrieval.topK,
                returnMetadata: 'all',
                ...(this.namespace ? { namespace: this.namespace } : {}),
            });
            if (!Array.isArray(results.matches)) throw new Error('Invalid Vectorize response');
            const ids = await parentSectionIds(results.matches, this.namespace);
            const sections = ids.length ? await this.vectorize.getByIds(ids) : [];
            this.timings.retrievalMs = performance.now() - searchStart;
            this.evidence = [];
            return contextFromMatches(expandSectionMatches(results.matches, sections), (excerpt) => {
                if (
                    typeof excerpt.url === 'string' &&
                    /^\/(?!\/)/.test(excerpt.url) &&
                    !/[\\\r\n]/.test(excerpt.url) &&
                    !/\/_context(?:\/|$)/.test(excerpt.url)
                ) {
                    this.evidence.push(excerpt);
                }
            });
        } catch (err) {
            console.error('Vector Search Failed:', err);
            throw new AppError('Retrieval service unavailable', 503);
        }
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
