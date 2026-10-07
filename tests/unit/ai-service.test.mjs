/**
 * Unit tests for AiService
 * Tests embedding generation, context retrieval, and stream generation
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiService } from '../../functions/_lib/ai.js';
import { createSseMessageStream } from '../../functions/_lib/guardrails.js';
import {
  makeEnv,
  buildEmbeddingsResponse,
  buildVectorizeResult,
  SAMPLE_DATA,
  FIXTURES,
} from '../helpers/index.mjs';

test('AiService', async (t) => {
  await t.test('getEmbeddings', async (t) => {
    await t.test('returns first vector from AI response', async () => {
      const vector = SAMPLE_DATA.EMBEDDING_VECTOR;
      const svc = new AiService(makeEnv({
        aiRun: async () => buildEmbeddingsResponse(vector),
      }));

      const result = await svc.getEmbeddings('hello');

      assert.deepEqual(result, vector);
    });

    await t.test('reports service unavailable when AI throws', async () => {
      const svc = new AiService(makeEnv({
        aiRun: async () => { throw new Error('AI unavailable'); },
      }));

      await assert.rejects(svc.getEmbeddings('hello'), { status: 503 });
    });
  });

  await t.test('retrieveContext', async (t) => {
    await t.test('reports service unavailable when VECTORIZE_INDEX is not bound', async () => {
      const svc = new AiService({
        AI: { run: async () => buildEmbeddingsResponse([0.1]) }
      });

      await assert.rejects(svc.retrieveContext('query'), { status: 503 });
    });

    await t.test('reports service unavailable when embedding fails', async () => {
      const svc = new AiService(makeEnv({
        aiRun: async () => { throw new Error('fail'); },
        vectorizeQuery: async () => { throw new Error('should not be called'); },
      }));

      await assert.rejects(svc.retrieveContext('query'), { status: 503 });
    });

    await t.test('joins matched text chunks with separator', async () => {
      const svc = new AiService(makeEnv({
        aiRun: async () => buildEmbeddingsResponse([0.1, 0.2]),
        vectorizeQuery: async () => buildVectorizeResult([
          { text: 'chunk one' },
          { text: 'chunk two' },
        ]),
      }));

      const result = await svc.retrieveContext('query');

      assert.equal(result, 'chunk one\n---\nchunk two');
    });

    await t.test('skips matches with no metadata text', async () => {
      const svc = new AiService(makeEnv({
        aiRun: async () => buildEmbeddingsResponse([0.1]),
        vectorizeQuery: async () => ({
          matches: [
            { metadata: { text: 'good chunk' } },
            { metadata: {} },
            {},
          ],
        }),
      }));

      const result = await svc.retrieveContext('query');

      assert.equal(result, 'good chunk');
    });

    await t.test('reports service unavailable when vectorize throws', async () => {
      const svc = new AiService(makeEnv({
        aiRun: async () => buildEmbeddingsResponse([0.1]),
        vectorizeQuery: async () => { throw new Error('vectorize down'); },
      }));

      await assert.rejects(svc.retrieveContext('query'), { status: 503 });
    });

    await t.test('returns empty string when no matches', async () => {
      const svc = new AiService(makeEnv({
        aiRun: async () => buildEmbeddingsResponse([0.1]),
        vectorizeQuery: async () => buildVectorizeResult([]),
      }));

      const result = await svc.retrieveContext('query');

      assert.equal(result, '');
    });

    await t.test('passes the selected corpus namespace to Vectorize', async () => {
      const svc = new AiService({
        ...makeEnv({
          aiRun: async () => buildEmbeddingsResponse([0.1]),
          vectorizeQuery: async (vector, options) => {
            assert.equal(options.namespace, 'corpus-test');
            return buildVectorizeResult([]);
          },
        }),
        AI_CORPUS_NAMESPACE: 'corpus-test',
      });
      assert.equal(await svc.retrieveContext('query'), '');
    });

    await t.test('rejects malformed embeddings instead of abstaining', async () => {
      const svc = new AiService(makeEnv({ aiRun: async () => ({ data: [[]] }) }));
      await assert.rejects(svc.getEmbeddings('query'), { status: 503 });
    });
  });

  await t.test('generateStream', async (t) => {
    await t.test('reports generation service failure explicitly', async () => {
      const svc = new AiService(makeEnv({ aiRun: async () => { throw new Error('model unavailable'); } }));
      await assert.rejects(svc.generateStream('query', 'context'), { status: 503 });
    });
    await t.test('passes system prompt, history, and user query to AI', async () => {
      const calls = [];
      const svc = new AiService(makeEnv({
        aiRun: async (model, payload) => {
          calls.push({ model, payload });
          return createSseMessageStream('Answer');
        },
      }));

      const result = await svc.generateStream(
        SAMPLE_DATA.SAFE_QUERY,
        'context text',
        FIXTURES.SIMPLE_HISTORY
      );

      assert.match(await new Response(result).text(), /"response":"Answer"/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].model, '@cf/zai-org/glm-4.7-flash');

      const { messages } = calls[0].payload;
      assert.equal(messages[0].role, 'system');
      assert.match(messages[0].content, /context text/);
      assert.deepEqual(messages.slice(1, -1), FIXTURES.SIMPLE_HISTORY);
      assert.equal(messages.at(-1).role, 'user');
      assert.equal(messages.at(-1).content, SAMPLE_DATA.SAFE_QUERY);
      assert.equal(calls[0].payload.stream, true);
      assert.deepEqual(calls[0].payload.chat_template_kwargs, { enable_thinking: false });
    });

    await t.test('defaults history to empty array when omitted', async () => {
      const calls = [];
      const svc = new AiService(makeEnv({
        aiRun: async (model, payload) => {
          calls.push(payload);
          return createSseMessageStream('Answer');
        },
      }));

      await svc.generateStream('query', 'ctx');

      const { messages } = calls[0];
      // system + user only, no history in between
      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, 'system');
      assert.equal(messages[1].role, 'user');
    });
  });
});
