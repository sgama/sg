/**
 * Unit tests for /api/chat endpoint
 * Tests CORS handling, input validation, guardrails, and end-to-end chat flow
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../../functions/api/chat.js';
import { createSseMessageStream as createSseStream } from '../../functions/_lib/guardrails.js';
import { 
  createContext,
  buildEmbeddingsResponse,
  buildVectorizeResult,
  URLS,
  SAMPLE_DATA,
  FIXTURES,
} from '../helpers/index.mjs';

test('/api/chat', async (t) => {
  await t.test('CORS', async (t) => {
    await t.test('returns CORS headers for OPTIONS requests from allowed origin', async () => {
      const response = await onRequest(createContext({ 
        method: 'OPTIONS',
        url: `${URLS.TEST_API_ENDPOINT}/chat`,
      }));

      // Hono cors middleware returns 204 for preflight (spec-correct)
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), URLS.ALLOWED_ORIGIN);
      assert.match(response.headers.get('Access-Control-Allow-Methods'), /POST/);
      assert.equal(response.headers.get('Access-Control-Max-Age'), '86400');
    });

    await t.test('blocks OPTIONS requests from disallowed origins', async () => {
      const response = await onRequest(createContext({ 
        method: 'OPTIONS',
        url: `${URLS.TEST_API_ENDPOINT}/chat`,
        origin: URLS.DISALLOWED_ORIGIN,
      }));

      // Hono returns 204 but omits ACAO header — browser will block the actual request
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    });
  });

  await t.test('Validation', async (t) => {
    await t.test('rejects blank queries after trimming whitespace', async () => {
      const response = await onRequest(createContext({ 
        method: 'POST',
        url: `${URLS.TEST_API_ENDPOINT}/chat`,
        body: { query: '   ' },
      }));

      assert.equal(response.status, 400);
      assert.match(response.headers.get('Content-Type'), /application\/json/);
      assert.deepEqual(await response.json(), {
        error: 'Invalid query. Must be a string < 500 chars.'
      });
    });

    await t.test('returns 503 when AI binding is missing', async () => {
      const response = await onRequest(createContext({ 
        method: 'POST',
        url: `${URLS.TEST_API_ENDPOINT}/chat`,
        body: { query: 'hello' },
      }));

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: 'Service Unavailable: AI binding missing'
      });
    });
  });

  await t.test('Guardrails', async (t) => {
    await t.test('rejects prompt injection style queries', async () => {
      const response = await onRequest(createContext({
        method: 'POST',
        url: `${URLS.TEST_API_ENDPOINT}/chat`,
        body: { query: SAMPLE_DATA.INJECTION_QUERY },
      }));

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: 'Query rejected by guardrails.'
      });
    });

    await t.test('returns grounded fallback when retrieval has no context', async () => {
      const calls = [];
      const env = {
        AI: {
          async run(model, payload) {
            calls.push({ model, payload });
            if (payload?.text) {
              return buildEmbeddingsResponse([0.1, 0.2, 0.3]);
            }
            return createSseStream('Should not generate');
          }
        },
        VECTORIZE_INDEX: {
          async query() {
            return buildVectorizeResult([]);
          }
        }
      };

      const response = await onRequest(createContext({
        method: 'POST',
        url: `${URLS.TEST_API_ENDPOINT}/chat`,
        env,
        body: { query: 'Tell me unknown details' },
      }));

      const body = await response.text();
      assert.equal(response.status, 200);
      assert.match(body, /don't have enough reliable context/i);

      // Only embeddings should run; generation should be skipped due to abstain guardrail.
      assert.equal(calls.length, 1);
    });
  });

  await t.test('End-to-end flow', async (t) => {
    await t.test('passes trimmed query and sanitized history into generation', async () => {
      const calls = [];
      const env = {
        AI: {
          async run(model, payload) {
            calls.push({ model, payload });
            if (payload?.text) {
              return buildEmbeddingsResponse([0.1, 0.2, 0.3]);
            }
            return createSseStream();
          }
        },
        VECTORIZE_INDEX: {
          async query() {
            return buildVectorizeResult([SAMPLE_DATA.CONTEXT_TEXT]);
          }
        }
      };

      const response = await onRequest(createContext({
        method: 'POST',
        url: `${URLS.TEST_API_ENDPOINT}/chat`,
        env,
        body: {
          query: '  What do you build?  ',
          history: FIXTURES.VALID_HISTORY,
        },
      }));

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
      assert.equal(response.headers.get('Cache-Control'), 'no-cache');

      assert.equal(calls.length, 2);
      assert.equal(calls[1].payload.messages.at(-1).content, 'What do you build?');
      assert.deepEqual(calls[1].payload.messages.slice(1, -1), FIXTURES.VALID_HISTORY);
    });

    await t.test('logs streamed output to KV when CHAT_LOGS is configured', async () => {
      const savedEntries = [];
      const pending = [];
      const env = {
        AI: {
          async run(model, payload) {
            if (payload?.text) {
              return buildEmbeddingsResponse([0.1, 0.2, 0.3]);
            }
            return createSseStream('Logged response');
          }
        },
        VECTORIZE_INDEX: {
          async query() {
            return buildVectorizeResult(['Relevant portfolio context for response.']);
          }
        },
        CHAT_LOGS: {
          async put(key, value, options) {
            savedEntries.push({ key, value: options?.metadata ?? JSON.parse(value || 'null') });
          }
        }
      };

      const response = await onRequest(createContext({
        method: 'POST',
        url: `${URLS.TEST_API_ENDPOINT}/chat`,
        env,
        waitUntil(promise) {
          pending.push(promise);
        },
        body: { query: 'Persist this' },
      }));

      await response.text();
      await Promise.all(pending);

      assert.equal(savedEntries.length, 1);
      assert.ok(savedEntries[0].key.startsWith('chat:'));
      assert.equal(savedEntries[0].value.query, 'Persist this');
      assert.equal(savedEntries[0].value.response, 'Logged response');
    });
  });
});
