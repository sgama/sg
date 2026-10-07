export const AI_CONFIG = {
    embedding: { model: '@cf/baai/bge-base-en-v1.5', dimensions: 768 },
    retrieval: { indexName: 'portfolio-index', topK: 3, maxContextChars: 12000 },
    generation: { defaultModel: 'glm', maxCompletionTokens: 512 },
    pricingDate: '2026-10-07',
};

export const AI_MODELS = {
    glm: {
        id: '@cf/zai-org/glm-4.7-flash',
        inputPerMillion: 0.0605,
        outputPerMillion: 0.40,
        completionLimitKey: 'max_completion_tokens',
        parameters: { chat_template_kwargs: { enable_thinking: false } },
    },
    gemma: {
        id: '@cf/google/gemma-4-26b-a4b-it',
        inputPerMillion: 0.10,
        outputPerMillion: 0.30,
        completionLimitKey: 'max_completion_tokens',
        parameters: { chat_template_kwargs: { enable_thinking: false } },
    },
    llama: {
        id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        inputPerMillion: 0.293,
        outputPerMillion: 2.253,
        completionLimitKey: 'max_tokens',
        parameters: {},
    },
};

export function getModel(name = AI_CONFIG.generation.defaultModel) {
    const model = AI_MODELS[name] ?? Object.values(AI_MODELS).find(item => item.id === name);
    if (!model) throw new Error(`Unknown AI model: ${name}. Choose ${Object.keys(AI_MODELS).join(', ')}`);
    return model;
}

export function generationInput(model, messages) {
    return {
        messages,
        stream: true,
        [model.completionLimitKey]: AI_CONFIG.generation.maxCompletionTokens,
        ...model.parameters,
    };
}

export function contextFromMatches(matches) {
    return matches
        .map(match => match.metadata?.text)
        .filter(text => typeof text === 'string' && text.trim())
        .join('\n---\n')
        .slice(0, AI_CONFIG.retrieval.maxContextChars);
}
