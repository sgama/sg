/**
 * Unit tests for /api/chat endpoint
 * Tests CORS handling, input validation, guardrails, and end-to-end chat flow
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../../functions/api/chat.js';
import { createSseMessageStream as createSseStream } from '../../functions/_lib/chat-stream.js';
import {
  buildEmbeddingsResponse,
  buildVectorizeResult,
  URLS,
  SAMPLE_DATA,
  FIXTURES,
} from '../helpers/data.mjs';
import { createContext, makeStream } from '../helpers/mocks.mjs';

test('/api/chat', async (t) => {
  await t.test('CORS', async (t) => {
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
  });

  await t.test('End-to-end flow', async (t) => {
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
          async put(key, value) {
            savedEntries.push({ key, value: JSON.parse(value) });
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

    await t.test('normalizes GLM output before streaming to the widget and saving to KV', async () => {
      const saved = [];
      const pending = [];
      const usage = { prompt_tokens: 1195, completion_tokens: 787, total_tokens: 1982 };
      const env = {
        AI: {
          async run(model, payload) {
            if (payload.text) return buildEmbeddingsResponse([0.1]);
            assert.equal(payload.chat_template_kwargs.enable_thinking, false);
            return makeStream(
              'data: {"choices":[{"index":0,"delta":{"reasoning_content":"private"}}]}\n',
              'data: {"choices":[{"index":0,"delta":{"content":"Visible answer"}}]}\n',
              `data: ${JSON.stringify({ response: '', usage })}\n`,
              'data: [DONE]\n',
            );
          },
        },
        VECTORIZE_INDEX: {
          async query() {
            return buildVectorizeResult(['Relevant portfolio context for response.']);
          },
        },
        CHAT_LOGS: {
          async put(_key, value) {
            saved.push(JSON.parse(value));
          },
        },
      };
      const response = await onRequest(createContext({
        method: 'POST',
        url: `${URLS.TEST_API_ENDPOINT}/chat`,
        body: { query: 'What do you build?' },
        env,
        waitUntil(promise) { pending.push(promise); },
      }));
      const output = await response.text();
      await Promise.all(pending);
      assert.equal(response.status, 200);
      assert.match(output, /"response":"Visible answer"/);
      assert.doesNotMatch(output, /private|reasoning|choices/);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].response, 'Visible answer');
      assert.deepEqual(saved[0].usage, usage);
    });

    await t.test('passes trimmed query and sanitized history into generation', async () => {
      const calls = [];
      const env = {
        AI: {
          async run(model, payload) {
            calls.push({ model, payload });
            if (payload?.text) {
              return buildEmbeddingsResponse([0.1, 0.2, 0.3]);
            }
            return createSseStream('Supported answer');
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
      assert.match(await response.text(), /"response":"Supported answer"/);

      assert.equal(calls.length, 2);
      assert.equal(calls[1].payload.messages.at(-1).content, 'What do you build?');
      assert.deepEqual(calls[1].payload.messages.slice(1, -1), FIXTURES.VALID_HISTORY);
    });

    await t.test('sends an explicit error when GLM finishes with reasoning but no answer', async (t) => {
      const logged = t.mock.method(console, 'error', () => {});
      const env = {
        AI: {
          async run(model, payload) {
            if (payload.text) return buildEmbeddingsResponse([0.1]);
            return makeStream(
              'data: {"choices":[{"index":0,"delta":{"reasoning_content":"private"}}]}\n',
              'data: {"response":""}\n',
              'data: [DONE]\n',
            );
          },
        },
        VECTORIZE_INDEX: {
          async query() {
            return buildVectorizeResult(['Relevant portfolio context for response.']);
          },
        },
      };
      const response = await onRequest(createContext({
        method: 'POST',
        url: `${URLS.TEST_API_ENDPOINT}/chat`,
        body: { query: 'What do you build?' },
        env,
      }));
      const output = await response.text();
      assert.match(output, /"error":"AI response failed\. Please try again\."/);
      assert.doesNotMatch(output, /private|reasoning/);
      assert.match(output, /data: \[DONE\]/);
      assert.equal(logged.mock.callCount(), 1);
      const [label, failure] = logged.mock.calls[0].arguments;
      assert.equal(logged.mock.calls[0].arguments.length, 2);
      assert.equal(label, 'Chat Stream Failed:');
      assert.ok(failure instanceof Error);
      assert.equal(failure.message, 'AI stream completed without an answer');
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
    await t.test('returns 503 for a retrieval outage instead of a successful abstention', async (t) => {
      const logged = t.mock.method(console, 'error', () => {});
      const response = await onRequest(createContext({
        method: 'POST', url: `${URLS.TEST_API_ENDPOINT}/chat`,
        body: { query: 'What do you build?' },
        env: { AI: { run: async () => { throw new Error('Should not be called'); } } },
      }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'Retrieval service unavailable' });
      assert.equal(logged.mock.callCount(), 1);
      assert.deepEqual(logged.mock.calls[0].arguments,
        ['Vector Search Failed: VECTORIZE_INDEX binding missing']);
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
});
