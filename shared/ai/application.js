import chatAi from '../../data/chat_ai.json' with { type: 'json' };
import { contextualizationMessages } from './prompts.js';

// The public config lives in data/chat_ai.json; this file simply exposes the exact model registry and
// limits used by runtime and evaluation callers. Keep the wiring here, not in each consumer.
/** @typedef {{ id: string, inputPerMillion: number, outputPerMillion: number, completionLimitKey: string, parameters: Record<string, unknown> }} Model */
/** @typedef {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }} Usage */
/** @typedef {string | { response?: unknown, choices?: { message?: { content?: unknown } }[] } | null | undefined} RewriteResponse */
/** @typedef {{ role: string, content: string }} ChatMessage */

export const AI_CONFIG = chatAi.config;
export const AI_MODELS = /** @type {Record<string, Model>} */ (chatAi.models);

/**
 * @param {string} [name]
 * @returns {Model}
 */
export function getModel(name = AI_CONFIG.generation.defaultModel) {
    const model = AI_MODELS[name] ?? Object.values(AI_MODELS).find((item) => item.id === name);
    if (!model) throw new Error(`Unknown AI model: ${name}. Choose ${Object.keys(AI_MODELS).join(', ')}`);
    return model;
}

/** @param {unknown} vector @param {number} dimensions */
export function isValidEmbeddingVector(vector, dimensions) {
    return Array.isArray(vector) && vector.length === dimensions && vector.every(Number.isFinite);
}

/** @param {Usage | null | undefined} usage @param {Model} model @returns {number | null} */
export function estimateCost(usage, model) {
    const prompt = usage?.prompt_tokens;
    const completion = usage?.completion_tokens;
    if (
        !Number.isFinite(model.inputPerMillion) ||
        !Number.isFinite(model.outputPerMillion) ||
        typeof prompt !== 'number' ||
        typeof completion !== 'number' ||
        !Number.isFinite(prompt) ||
        !Number.isFinite(completion) ||
        prompt < 0 ||
        completion < 0
    )
        return null;
    return (prompt * model.inputPerMillion + completion * model.outputPerMillion) / 1e6;
}

/** @param {Model} model @param {ChatMessage[]} messages */
export function generationInput(model, messages) {
    return {
        messages,
        stream: true,
        [model.completionLimitKey]: AI_CONFIG.generation.maxCompletionTokens,
        ...model.parameters,
    };
}

/** @param {Model} model @param {string} query @param {ChatMessage[]} [history] */
export function contextualizationInput(model, query, history = []) {
    return {
        messages: contextualizationMessages(query, history),
        stream: false,
        [model.completionLimitKey]: AI_CONFIG.contextualization.maxCompletionTokens,
        ...model.parameters,
    };
}

/** @param {RewriteResponse} response */
export function contextualizedQueryFromResponse(response) {
    const body = typeof response === 'object' ? response : null;
    const text = [response, body?.response, body?.choices?.[0]?.message?.content].find((value) => typeof value === 'string');
    if (text === undefined) throw new Error('Invalid contextualization response');
    const query = text.trim();
    if (!query || query.length > AI_CONFIG.contextualization.maxQueryChars || /[\r\n]/.test(query)) {
        throw new Error('Invalid contextualized query');
    }
    return query;
}

/**
 * @param {string} query
 * @param {ChatMessage[]} history
 * @param {Model} model
 * @param {(modelId: string, input: object) => Promise<RewriteResponse>} run
 */
export async function rewriteSearchQuery(query, history, model, run) {
    return contextualizedQueryFromResponse(await run(model.id, contextualizationInput(model, query, history)));
}

export const CONFIG = {
    HISTORY: {
        // Max history messages (user and assistant combined) accepted alongside the new query.
        // Older messages are dropped by the client.
        MAX_TURNS: 4,
        // Per-message cap: each entry still must fit before the aggregated history budget is checked.
        MAX_CONTENT_LENGTH: 2000,
        // Total character budget across all history messages combined.
        MAX_TOTAL_LENGTH: 4000,
    },
    // Public query limit (characters, after trimming).
    QUERY: { MAX_LENGTH: 500 },
    // Below this much retrieved context the assistant abstains instead of answering.
    ABSTAIN: { MIN_CONTEXT_CHARS: 20 },
};
