/**
 * Test fixtures and builders
 * Provides pre-built test data and builder patterns for complex objects
 */

import { TIMESTAMPS, SAMPLE_DATA } from './constants.mjs';

/**
 * Build a chat history array
 * @param {Array<{role: string, content: string}>} turns - Conversation turns
 * @returns {Array} Chat history array
 */
export function buildHistory(...turns) {
  return turns;
}

/**
 * Build a KV key with metadata
 * @param {Object} options
 * @param {string} options.name - Key name
 * @param {string} options.query - Query text
 * @param {string} options.response - Response text
 * @param {string} options.timestamp - ISO timestamp
 * @param {Object} options.usage - Token usage stats
 * @returns {Object} KV key object with metadata
 */
export function buildKvKey({ 
  name = `chat:${TIMESTAMPS.FIXED_TS}`, 
  query = 'test query',
  response = 'test response',
  timestamp = TIMESTAMPS.FIXED_TS,
  usage = null,
} = {}) {
  return {
    name,
    metadata: {
      timestamp,
      query,
      response,
      usage,
    },
  };
}

/**
 * Build a vectorize query result
 * @param {Array<{text: string}>} chunks - Array of text chunks
 * @returns {Object} Vectorize query result
 */
export function buildVectorizeResult(chunks = []) {
  return {
    matches: chunks.map(chunk => ({
      metadata: typeof chunk === 'string' ? { text: chunk } : chunk,
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
 * Build SSE message lines for streaming responses
 * @param {Object} options
 * @param {string} options.response - Response text
 * @param {Object} options.usage - Token usage stats
 * @returns {Array<string>} Array of SSE formatted lines
 */
export function buildSseMessages({ response = 'test response', usage = null } = {}) {
  const lines = [];
  
  if (response) {
    // Split response into chunks if it contains multiple words
    const chunks = response.split(' ');
    chunks.forEach((chunk, i) => {
      const text = i === 0 ? chunk : ` ${chunk}`;
      lines.push(`data: ${JSON.stringify({ response: text })}\n`);
    });
  }
  
  if (usage) {
    lines.push(`data: ${JSON.stringify({ usage })}\n`);
  }
  
  lines.push('data: [DONE]\n');
  return lines;
}

/**
 * Common test fixtures
 */
export const FIXTURES = {
  VALID_HISTORY: buildHistory(
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello there' },
    { role: 'user', content: 'Tell me more' }
  ),
  
  SIMPLE_HISTORY: buildHistory(
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello' }
  ),

  USAGE_STATS: {
    prompt_tokens: 10,
    completion_tokens: 5,
  },

  CONTEXT_CHUNKS: [
    'Samson builds software systems and platforms.',
    'He specializes in distributed systems and cloud architecture.',
  ],
};
