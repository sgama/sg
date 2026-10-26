import chatAi from '../../data/chat_ai.json' with { type: 'json' };
import { contextualizationMessages } from './prompts.js';

export const AI_CONFIG = chatAi.config;
export const AI_MODELS = chatAi.models;

export function getModel(name = AI_CONFIG.generation.defaultModel) {
    const model = AI_MODELS[name] ?? Object.values(AI_MODELS).find((item) => item.id === name);
    if (!model) throw new Error(`Unknown AI model: ${name}. Choose ${Object.keys(AI_MODELS).join(', ')}`);
    return model;
}

/** @param {unknown} vector @param {number} dimensions */
export function isValidEmbeddingVector(vector, dimensions) {
    return Array.isArray(vector) && vector.length === dimensions && vector.every(Number.isFinite);
}

export function estimateCost(usage, model) {
    if (
        !Number.isFinite(model.inputPerMillion) ||
        !Number.isFinite(model.outputPerMillion) ||
        !Number.isFinite(usage?.prompt_tokens) ||
        !Number.isFinite(usage?.completion_tokens) ||
        usage.prompt_tokens < 0 ||
        usage.completion_tokens < 0
    )
        return null;
    return (usage.prompt_tokens * model.inputPerMillion + usage.completion_tokens * model.outputPerMillion) / 1e6;
}

export function generationInput(model, messages) {
    return {
        messages,
        stream: true,
        [model.completionLimitKey]: AI_CONFIG.generation.maxCompletionTokens,
        ...model.parameters,
    };
}

export function contextualizationInput(model, query, history = []) {
    return {
        messages: contextualizationMessages(query, history),
        stream: false,
        [model.completionLimitKey]: AI_CONFIG.contextualization.maxCompletionTokens,
        ...model.parameters,
    };
}

export function contextualizedQueryFromResponse(response) {
    const text =
        typeof response === 'string'
            ? response
            : typeof response?.response === 'string'
              ? response.response
              : typeof response?.choices?.[0]?.message?.content === 'string'
                ? response.choices[0].message.content
                : null;
    if (text === null) throw new Error('Invalid contextualization response');
    const query = text.trim();
    if (!query || query.length > AI_CONFIG.contextualization.maxQueryChars || /[\r\n]/.test(query)) {
        throw new Error('Invalid contextualized query');
    }
    return query;
}

export async function rewriteSearchQuery(query, history, model, run) {
    return contextualizedQueryFromResponse(await run(model.id, contextualizationInput(model, query, history)));
}

export const CONFIG = {
    HISTORY: {
        // Max history messages (user and assistant combined) accepted
        // alongside the new query. Older messages are dropped by the client.
        MAX_TURNS: 4,
        MAX_CONTENT_LENGTH: 2000,
        // Total character budget across all history messages combined
        MAX_TOTAL_LENGTH: 4000,
    },
    PAGINATION: {
        DEFAULT_LIMIT: 20,
        MAX_LIMIT: 50,
    },
    // Public query limit (characters, after trimming).
    QUERY: { MAX_LENGTH: 500 },
    // Below this much retrieved context the assistant abstains instead of answering.
    ABSTAIN: { MIN_CONTEXT_CHARS: 20 },
    KV_PREFIX: 'chat:',
};

export class AppError extends Error {
    /**
     * @param {string} message
     * @param {import('hono/utils/http-status').ContentfulStatusCode} [status]
     */
    constructor(message, status = 500) {
        super(message);
        this.status = status;
        this.name = this.constructor.name;
    }
}

/**
 * Both the request path and the service fail the same way when the Vectorize binding is absent: one
 * log line and one client-facing 503. The request path checks early so it fails before SSE headers.
 * @param {unknown} vectorize
 */
export function requireVectorizeBinding(vectorize) {
    if (vectorize) return;
    console.error('Vector Search Failed: VECTORIZE_INDEX binding missing');
    throw new AppError('Retrieval service unavailable', 503);
}
