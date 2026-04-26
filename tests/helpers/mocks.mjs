/**
 * Mock factories for common test objects
 * Provides reusable mock objects for AI bindings, KV stores, vectorize indexes, etc.
 */

import { TIMESTAMPS } from './constants.mjs';

/**
 * Create a mock Cloudflare AI binding
 * @param {Object} options
 * @param {Function} options.aiRun - Mock AI.run implementation
 * @returns {Object} Mock AI binding
 */
export function makeAiBinding({ aiRun } = {}) {
  return {
    AI: {
      run: aiRun ?? (async () => { throw new Error('AI.run not configured'); }),
    },
  };
}

/**
 * Create a mock Vectorize index binding
 * @param {Function} queryFn - Mock query implementation
 * @returns {Object} Mock Vectorize index
 */
export function makeVectorizeIndex(queryFn) {
  if (!queryFn) return undefined;
  return {
    query: queryFn,
  };
}

/**
 * Create a complete mock environment with AI and Vectorize
 * @param {Object} options
 * @param {Function} options.aiRun - Mock AI.run implementation
 * @param {Function} options.vectorizeQuery - Mock Vectorize query implementation
 * @returns {Object} Mock environment object
 */
export function makeEnv({ aiRun, vectorizeQuery } = {}) {
  return {
    ...makeAiBinding({ aiRun }),
    VECTORIZE_INDEX: makeVectorizeIndex(vectorizeQuery),
  };
}

/**
 * Create a mock KV namespace for CHAT_LOGS
 * @param {Object} options
 * @param {Array} options.keys - Array of key objects with metadata
 * @param {string} options.cursor - Pagination cursor
 * @param {boolean} options.list_complete - Whether the list is complete
 * @returns {Object} Mock KV namespace
 */
export function makeKv({ keys = [], cursor = undefined, list_complete = true } = {}) {
  return {
    async list({ prefix, limit, cursor: inputCursor } = {}) {
      return { keys, cursor, list_complete };
    },
    async put(key, value, options) {
      // Default mock does nothing; override in specific tests
    },
  };
}

/**
 * Create a mock Request context for API handlers
 * @param {Object} options
 * @param {string} options.method - HTTP method
 * @param {string} options.url - Request URL
 * @param {Object} options.body - Request body (will be JSON stringified)
 * @param {Object} options.env - Environment bindings
 * @param {Function} options.waitUntil - waitUntil implementation
 * @param {string} options.origin - Origin header value
 * @returns {Object} Request context with request, env, and waitUntil
 */
export function createContext({
  method = 'GET',
  url = 'https://example.com/api',
  body,
  env = {},
  waitUntil,
  origin = 'https://samsongama.com'
} = {}) {
  const request = new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { 'Origin': origin } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return {
    request,
    env,
    ...(waitUntil ? { waitUntil } : {}),
  };
}

/**
 * Create a mock SSE stream from text chunks
 * @param  {...string} sseLines - SSE formatted lines
 * @returns {ReadableStream} Stream of SSE data
 */
export function makeStream(...sseLines) {
  const encoder = new TextEncoder();
  const chunks = sseLines.map(l => encoder.encode(l + '\n'));
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/**
 * Drain a readable stream to string
 * @param {ReadableStream} stream
 * @returns {Promise<string>} The complete stream content
 */
export async function drainStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

/**
 * Create a fixed timestamp provider for testing
 * @param {string} timestamp - ISO timestamp to return
 * @returns {Function} Function that returns the fixed timestamp
 */
export function makeTimestamp(timestamp = TIMESTAMPS.FIXED_TS) {
  return () => timestamp;
}
