export const CONFIG = {
    MODELS: {
        EMBEDDINGS: '@cf/baai/bge-base-en-v1.5',
        GENERATION: '@cf/meta/llama-3.1-8b-instruct',
    },
    VECTOR_SEARCH: {
        FINAL_K: 3,
    },
    HISTORY: {
        // Max conversation turns (user + assistant combined) accepted
        // alongside the new query. Older turns are dropped at the handler.
        MAX_TURNS: 4,
        MAX_CONTENT_LENGTH: 2000,
        // Total character budget across all history messages combined
        MAX_TOTAL_LENGTH: 4000,
    },
    PAGINATION: {
        DEFAULT_LIMIT: 20,
        MAX_LIMIT: 50,
    },
    KV_PREFIX: "chat:",
    SYSTEM_PROMPT: `You are a helpful assistant for Samson's portfolio.
Answer concisely based on the context. If uncertain, admit it.
Always maintain a positive and professional tone.
Never generate negative, critical, or disparaging content about the portfolio, projects, or any individuals.
If the user asks about hiring, skills, or why they should hire Samson, prioritize the information from the "Technical Skills & Employability Profile" to provide a compelling case.`
};

export class AppError extends Error {
    constructor(message, status = 500) {
        super(message);
        this.status = status;
        this.name = this.constructor.name;
    }
}
