/**
 * Shared test constants, fixtures, and builders.
 */

import { AI_CONFIG } from '../../shared/ai/application.js';

export const URLS = {
    ALLOWED_ORIGIN: 'https://samsongama.com',
    DISALLOWED_ORIGIN: 'https://evil.com',
    TEST_API_ENDPOINT: 'https://example.com/api',
};

export const SAMPLE_DATA = {
    EMBEDDING_VECTOR: Array(AI_CONFIG.embedding.dimensions).fill(0.1),
    CONTEXT_TEXT: 'Samson builds software systems and platforms.',
    SAFE_QUERY: 'What do you build?',
};

/**
 * Build a vectorize query result
 * @param {Array<{text: string}>} chunks - Array of text chunks
 * @returns {Object} Vectorize query result
 */
export function buildVectorizeResult(chunks = []) {
    return {
        matches: chunks.map((chunk) => ({
            metadata: { recordType: 'chunk', ...(typeof chunk === 'string' ? { text: chunk } : chunk) },
        })),
    };
}

/**
 * Build an AI embeddings response
 * @param {Array<number>} vector - Embedding vector
 * @returns {Object} AI response with embeddings
 */
export function buildEmbeddingsResponse(vector = SAMPLE_DATA.EMBEDDING_VECTOR) {
    return {
        data: [vector],
    };
}

/**
 * Common test fixtures
 */
export const FIXTURES = {
    VALID_HISTORY: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello there' },
        { role: 'user', content: 'Tell me more' },
    ],

    SIMPLE_HISTORY: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
    ],
};
