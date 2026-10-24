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
    corpusRecordId,
    estimateCost,
} from './application.js';
import { normalizeChatStream } from './chat-stream.js';

export class AiService {
    constructor(env, { cache = null } = {}) {
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
        // Workers Cache API is opt-in via the seam; production wires caches.default in chat.js.
        this.cache = cache;
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

        // Retrieval cache: namespace + contextualized query is deterministic.
        const cacheKey = this.cache ? await this.retrievalCacheKey(retrievalQuery) : null;
        if (cacheKey) {
            try {
                const cached = await this.cache.match(cacheKey);
                if (cached) {
                    const payload = await cached.json();
                    this.timings.retrievalMs = 0;
                    this.evidence = Array.isArray(payload.evidence) ? payload.evidence.map((item) => ({ ...item })) : [];
                    await onProgress('search');
                    return payload.contextText;
                }
            } catch (err) {
                console.error('Retrieval cache read failed:', err);
            }
        }

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
            const inlined =
                results.matches.length > 0 &&
                results.matches.every((m) => typeof m?.metadata?.sectionText === 'string' && m.metadata.sectionText.trim());
            const ids = inlined ? [] : await parentSectionIds(results.matches, this.namespace);
            const sections = inlined
                ? synthesizeInlinedSections(results.matches, this.namespace)
                : ids.length
                  ? await this.vectorize.getByIds(ids)
                  : [];
            this.timings.retrievalMs = performance.now() - searchStart;
            this.evidence = [];
            const contextText = contextFromMatches(expandSectionMatches(results.matches, sections), (excerpt) => {
                if (
                    typeof excerpt.url === 'string' &&
                    /^\/(?!\/)/.test(excerpt.url) &&
                    !/[\\\r\n]/.test(excerpt.url) &&
                    !/\/_context(?:\/|$)/.test(excerpt.url)
                ) {
                    this.evidence.push(excerpt);
                }
            });

            // Only cache non-empty contexts; empty results stay fresh.
            if (cacheKey && contextText.trim().length >= 20) {
                const evidenceSnapshot = this.evidence.map((item) => ({ ...item }));
                const response = new Response(JSON.stringify({ contextText, evidence: evidenceSnapshot }), {
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' },
                });
                this.cache.put(cacheKey, response).catch((err) => console.error('Retrieval cache write failed:', err));
            }

            return contextText;
        } catch (err) {
            console.error('Vector Search Failed:', err);
            throw new AppError('Retrieval service unavailable', 503);
        }
    }

    async retrievalCacheKey(retrievalQuery) {
        const input = `v1:${this.namespace ?? ''}:${retrievalQuery}`;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
        const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        return new Request(`https://rag-cache.internal/v1?ns=${encodeURIComponent(this.namespace ?? '')}&q=${hex}`, { method: 'GET' });
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

async function synthesizeInlinedSections(matches, namespace) {
    const seen = new Set();
    const sections = [];
    for (const match of matches) {
        const md = match.metadata || {};
        const source = typeof md.source === 'string' ? md.source : '';
        if (md.recordType === 'section' && typeof md.sectionText === 'string' && md.sectionText.trim()) {
            const index = Number.isInteger(md.sectionIndex) ? md.sectionIndex : -1;
            const key = `${source}\0${index}`;
            if (!seen.has(key)) {
                seen.add(key);
                sections.push({
                    metadata: {
                        source,
                        section: md.section,
                        recordType: 'section',
                        sectionIndex: index,
                        text: md.sectionText,
                        type: 'content',
                    },
                    id: await corpusRecordId(namespace, source, index),
                    score: match.score,
                });
            }
        }
        for (const prefix of ['parent', 'canonical']) {
            if (md[`${prefix}Index`] === undefined) continue;
            const index = md[`${prefix}Index`];
            if (!Number.isInteger(index) || index >= 0) continue;
            const refSource = typeof md[`${prefix}Source`] === 'string' && md[`${prefix}Source`].trim() ? md[`${prefix}Source`] : source;
            const text = md.sectionText;
            if (typeof text !== 'string' || !text.trim()) continue;
            const key = `${refSource}\0${index}`;
            if (seen.has(key)) continue;
            seen.add(key);
            sections.push({
                metadata: {
                    source: refSource,
                    section: md.section,
                    recordType: 'section',
                    sectionIndex: index,
                    text,
                    type: prefix === 'canonical' ? 'content' : undefined,
                },
                id: await corpusRecordId(namespace, refSource, index),
                score: match.score,
            });
        }
    }
    return sections;
}
