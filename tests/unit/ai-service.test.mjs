/**
 * Unit tests for AiService
 * Tests embedding generation, context retrieval, and stream generation
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiService } from '../../functions/_lib/ai.js';
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

    await t.test('returns null when AI throws', async () => {
      const svc = new AiService(makeEnv({
        aiRun: async () => { throw new Error('AI unavailable'); },
      }));
      
      const result = await svc.getEmbeddings('hello');
      
      assert.equal(result, null);
    });
  });

  await t.test('retrieveContext', async (t) => {
    await t.test('returns empty string when VECTORIZE_INDEX is not bound', async () => {
      const svc = new AiService({ 
        AI: { run: async () => buildEmbeddingsResponse([0.1]) } 
      });
      
      const result = await svc.retrieveContext('query');
      
      assert.equal(result, '');
    });

    await t.test('returns empty string when embedding fails', async () => {
      const svc = new AiService(makeEnv({
        aiRun: async () => { throw new Error('fail'); },
        vectorizeQuery: async () => { throw new Error('should not be called'); },
      }));
      
      const result = await svc.retrieveContext('query');
      
      assert.equal(result, '');
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

    await t.test('returns empty string when vectorize throws', async () => {
      const svc = new AiService(makeEnv({
        aiRun: async () => buildEmbeddingsResponse([0.1]),
        vectorizeQuery: async () => { throw new Error('vectorize down'); },
      }));
      
      const result = await svc.retrieveContext('query');
      
      assert.equal(result, '');
    });

    await t.test('returns empty string when no matches', async () => {
      const svc = new AiService(makeEnv({
        aiRun: async () => buildEmbeddingsResponse([0.1]),
        vectorizeQuery: async () => buildVectorizeResult([]),
      }));
      
      const result = await svc.retrieveContext('query');
      
      assert.equal(result, '');
    });
  });

  await t.test('generateStream', async (t) => {
    await t.test('passes system prompt, history, and user query to AI', async () => {
      const calls = [];
      const svc = new AiService(makeEnv({
        aiRun: async (model, payload) => {
          calls.push({ model, payload });
          return 'stream-stub';
        },
      }));

      const result = await svc.generateStream(
        SAMPLE_DATA.SAFE_QUERY, 
        'context text', 
        FIXTURES.SIMPLE_HISTORY
      );

      assert.equal(result, 'stream-stub');
      assert.equal(calls.length, 1);

      const { messages } = calls[0].payload;
      assert.equal(messages[0].role, 'system');
      assert.match(messages[0].content, /context text/);
      assert.deepEqual(messages.slice(1, -1), FIXTURES.SIMPLE_HISTORY);
      assert.equal(messages.at(-1).role, 'user');
      assert.equal(messages.at(-1).content, SAMPLE_DATA.SAFE_QUERY);
      assert.equal(calls[0].payload.stream, true);
    });

    await t.test('defaults history to empty array when omitted', async () => {
      const calls = [];
      const svc = new AiService(makeEnv({
        aiRun: async (model, payload) => { 
          calls.push(payload); 
          return 'stream'; 
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
