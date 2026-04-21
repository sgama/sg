export const CONFIG = {
    MODELS: {
        EMBEDDINGS: '@cf/baai/bge-base-en-v1.5',
        GENERATION: '@cf/meta/llama-3-8b-instruct',
        // Small + cheap model for relevance scoring only.
        RERANKER: '@cf/meta/llama-3.2-3b-instruct',
    },
    VECTOR_SEARCH: {
        // Over-retrieve then rerank down to FINAL_K. If RERANK_ENABLED is
        // false the pipeline falls back to the first FINAL_K matches.
        RETRIEVE_K: 10,
        FINAL_K: 3,
        // Each candidate passage is truncated to this many chars before
        // being shown to the reranker, to keep the scoring prompt small.
        RERANK_SNIPPET_CHARS: 400,
    },
    RERANK_ENABLED: true,
    HISTORY: {
        // Max conversation turns (user + assistant combined) accepted
        // alongside the new query. Older turns are dropped at the handler.
        MAX_TURNS: 4,
        MAX_CONTENT_LENGTH: 2000,
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
