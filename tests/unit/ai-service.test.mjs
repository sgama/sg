/**
 * Unit tests for AiService
 * Tests embedding generation, context retrieval, and stream generation
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiService } from '../../functions/_lib/ai.js';
import { AI_CONFIG, buildMessages, contextFromMatches } from '../../functions/_lib/application.js';
import { createSseMessageStream } from '../../functions/_lib/chat-stream.js';
import {
  buildEmbeddingsResponse,
  buildVectorizeResult,
  SAMPLE_DATA,
  FIXTURES,
} from '../helpers/data.mjs';
import { makeEnv } from '../helpers/mocks.mjs';

test('prompt uses retrieved evidence without injecting a separate resume copy', () => {
  const context = '## Technical Skills\nProgramming: Go, Python, Bash, C/C++, Java, JavaScript, Rust';
  const messages = buildMessages('Is C++ listed?', context,
    [{ role: 'assistant', content: 'C++ is not listed.' }]);
  assert.ok(messages[0].content.includes(context));
  assert.match(messages[0].content, /override conflicting older excerpts and conversation history/);
  assert.match(messages[0].content, /listing both languages/);
  assert.match(messages[0].content, /Do not treat an omitted fact as either confirmed or disproved/);
  assert.match(messages[0].content, /Do not exaggerate qualifications or suppress source-supported limitations/);
  assert.equal(messages.at(-1).content, 'Is C++ listed?');
  assert.ok(!buildMessages('Skills?', '')[0].content.includes('Mar 2026 - Jun 2026'));
});

test('retrieved context preserves source identity within the character budget', () => {
  const context = contextFromMatches([
    { metadata: { source: 'content/resume/_index.md', title: 'Resume', url: '/resume/',
      text: 'Programming: C/C++' } },
    { metadata: { source: 'content/posts/old/index.md', title: 'Older post', url: '/posts/old/',
      text: 'Older evidence' } },
  ]);
  assert.match(context, /Source: .*"source":"content\/resume\/_index.md".*"url":"\/resume\/"/);
  assert.match(context, /Source: .*"title":"Older post"/);
  assert.match(context, /Programming: C\/C\+\+\n---\nSource:/);
  const bounded = contextFromMatches([{ metadata: { source: 'resume', url: '/resume/',
    text: 'x'.repeat(AI_CONFIG.retrieval.maxContextChars * 2) } }]);
  assert.equal(bounded.length, AI_CONFIG.retrieval.maxContextChars);
});

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

    await t.test('reports service unavailable when AI throws', async (t) => {
      const logged = t.mock.method(console, 'error', () => {});
      const failure = new Error('AI unavailable');
      const svc = new AiService(makeEnv({
        aiRun: async () => { throw failure; },
      }));

      await assert.rejects(svc.getEmbeddings('hello'), {
        status: 503, message: 'Embedding service unavailable',
      });
      assert.equal(logged.mock.callCount(), 1);
      assert.deepEqual(logged.mock.calls[0].arguments, ['Embedding Generation Failed:', failure]);
    });
  });

  await t.test('retrieveContext', async (t) => {
    await t.test('reports service unavailable when VECTORIZE_INDEX is not bound', async (t) => {
      const logged = t.mock.method(console, 'error', () => {});
      const svc = new AiService({
        AI: { run: async () => buildEmbeddingsResponse([0.1]) }
      });

      await assert.rejects(svc.retrieveContext('query'), {
        status: 503, message: 'Retrieval service unavailable',
      });
      assert.equal(logged.mock.callCount(), 1);
      assert.deepEqual(logged.mock.calls[0].arguments,
        ['Vector Search Failed: VECTORIZE_INDEX binding missing']);
    });

    await t.test('reports service unavailable when embedding fails', async (t) => {
      const logged = t.mock.method(console, 'error', () => {});
      const failure = new Error('fail');
      const query = t.mock.fn(async () => { throw new Error('should not be called'); });
      const svc = new AiService(makeEnv({
        aiRun: async () => { throw failure; },
        vectorizeQuery: query,
      }));

      await assert.rejects(svc.retrieveContext('query'), {
        status: 503, message: 'Embedding service unavailable',
      });
      assert.equal(query.mock.callCount(), 0);
      assert.equal(logged.mock.callCount(), 1);
      assert.deepEqual(logged.mock.calls[0].arguments, ['Embedding Generation Failed:', failure]);
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

    await t.test('reports service unavailable when vectorize throws', async (t) => {
      const logged = t.mock.method(console, 'error', () => {});
      const failure = new Error('vectorize down');
      const svc = new AiService(makeEnv({
        aiRun: async () => buildEmbeddingsResponse([0.1]),
        vectorizeQuery: async () => { throw failure; },
      }));

      await assert.rejects(svc.retrieveContext('query'), {
        status: 503, message: 'Retrieval service unavailable',
      });
      assert.equal(logged.mock.callCount(), 1);
      assert.deepEqual(logged.mock.calls[0].arguments, ['Vector Search Failed:', failure]);
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

    await t.test('rejects malformed embeddings instead of abstaining', async (t) => {
      const logged = t.mock.method(console, 'error', () => {});
      const svc = new AiService(makeEnv({ aiRun: async () => ({ data: [[]] }) }));
      await assert.rejects(svc.getEmbeddings('query'), {
        status: 503, message: 'Embedding service unavailable',
      });
      assert.equal(logged.mock.callCount(), 1);
      const [label, failure] = logged.mock.calls[0].arguments;
      assert.equal(logged.mock.calls[0].arguments.length, 2);
      assert.equal(label, 'Embedding Generation Failed:');
      assert.ok(failure instanceof Error);
      assert.equal(failure.message, 'Invalid embedding response');
    });
  });

  await t.test('generateStream', async (t) => {
    await t.test('reports generation service failure explicitly', async (t) => {
      const logged = t.mock.method(console, 'error', () => {});
      const failure = new Error('model unavailable');
      const svc = new AiService(makeEnv({ aiRun: async () => { throw failure; } }));
      await assert.rejects(svc.generateStream('query', 'context'), {
        status: 503, message: 'Generation service unavailable',
      });
      assert.equal(logged.mock.callCount(), 1);
      assert.deepEqual(logged.mock.calls[0].arguments, ['Generation Failed:', failure]);
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
