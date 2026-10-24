import chatAi from '../../data/chat_ai.json' with { type: 'json' };
import { contextualizationMessages } from './prompts.js';

export const AI_CONFIG = chatAi.config;
export const AI_MODELS = chatAi.models;

export function getModel(name = AI_CONFIG.generation.defaultModel) {
    const model = AI_MODELS[name] ?? Object.values(AI_MODELS).find((item) => item.id === name);
    if (!model) throw new Error(`Unknown AI model: ${name}. Choose ${Object.keys(AI_MODELS).join(', ')}`);
    return model;
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
    constructor(message, status = 500) {
        super(message);
        this.status = status;
        this.name = this.constructor.name;
    }
}
