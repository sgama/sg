/**
 * Unit tests for LogService
 * Tests stream passthrough, KV persistence, and log retrieval
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LogService } from '../../functions/_lib/log.js';
import {
  makeStream,
  drainStream,
  makeTimestamp,
  buildKvKey,
  TIMESTAMPS,
  PAGINATION,
  FIXTURES,
} from '../helpers/index.mjs';

const now = makeTimestamp(TIMESTAMPS.FIXED_TS);

test('LogService', async (t) => {
  await t.test('save', async (t) => {
    await t.test('Passthrough behavior', async (t) => {
      await t.test('returns original stream unchanged when kv is falsy', async () => {
        const original = makeStream('data: {"response":"hi"}\n', 'data: [DONE]\n');
        const result = await LogService.save(null, 'query', original, null, { now });

        assert.equal(result, original);
      });

      await t.test('passes all chunks through to readable side unchanged', async () => {
        const kv = { put: async () => {} };
        const stream = makeStream(
          'data: {"response":"Hello"}\n',
          'data: {"response":" world"}\n',
          'data: [DONE]\n',
        );

        const piped = await LogService.save(kv, 'q', stream, null, { now });
        const output = await drainStream(piped);

        assert.match(output, /Hello/);
        assert.match(output, /world/);
        assert.match(output, /\[DONE\]/);
      });
    });

    await t.test('KV persistence', async (t) => {
      await t.test('persists accumulated response with correct key and metadata', async () => {
        const saved = [];
        const kv = {
          async put(key, value, options) {
            saved.push({ key, value, metadata: options?.metadata });
          },
        };

        const stream = makeStream(
          'data: {"response":"Hello"}\n',
          'data: {"response":" world"}\n',
          'data: [DONE]\n',
        );

        const piped = await LogService.save(kv, 'test query', stream, null, { now });
        await drainStream(piped);

        assert.equal(saved.length, 1);
        assert.equal(saved[0].key, `chat:${TIMESTAMPS.FIXED_TS}`);
        assert.equal(saved[0].metadata.query, 'test query');
        assert.equal(saved[0].metadata.response, 'Hello world');
        assert.equal(saved[0].metadata.timestamp, TIMESTAMPS.FIXED_TS);
      });

      await t.test('captures usage metadata when present in SSE payload', async () => {
        const saved = [];
        const kv = { put: async (k, v, o) => saved.push(o?.metadata) };

        const stream = makeStream(
          'data: {"response":"text"}\n',
          `data: {"usage":${JSON.stringify(FIXTURES.USAGE_STATS)}}\n`,
          'data: [DONE]\n',
        );

        const piped = await LogService.save(kv, 'q', stream, null, { now });
        await drainStream(piped);

        assert.deepEqual(saved[0].usage, FIXTURES.USAGE_STATS);
      });

      await t.test('tolerates malformed JSON in SSE data lines', async () => {
        const saved = [];
        const kv = { put: async (k, v, o) => saved.push(o?.metadata) };

        const stream = makeStream(
          'data: {"response":"ok"}\n',
          'data: {broken json\n',
          'data: [DONE]\n',
        );

        const piped = await LogService.save(kv, 'q', stream, null, { now });
        await drainStream(piped);

        // Only the valid chunk should accumulate
        assert.equal(saved[0].response, 'ok');
      });

      await t.test('uses context.waitUntil when available', async () => {
        const pending = [];
        const ctx = { waitUntil: (p) => pending.push(p) };
        const kv = { put: async () => {} };

        const stream = makeStream('data: {"response":"x"}\n', 'data: [DONE]\n');
        const piped = await LogService.save(kv, 'q', stream, ctx, { now });
        await drainStream(piped);

        assert.equal(pending.length, 1);
        await pending[0]; // should resolve without error
      });
    });
  });

  await t.test('fetchLogs', async (t) => {
    await t.test('returns logs in reverse chronological order', async () => {
      const kv = {
        async list() {
          return {
            keys: [
              buildKvKey({ name: 'chat:2026-01-01', query: 'first', response: 'a', timestamp: '2026-01-01' }),
              buildKvKey({ name: 'chat:2026-01-02', query: 'second', response: 'b', timestamp: '2026-01-02' }),
            ],
            list_complete: true,
            cursor: undefined,
          };
        },
      };

      const result = await LogService.fetchLogs(kv, PAGINATION.DEFAULT_LIMIT, undefined);

      assert.equal(result.data[0].query, 'second');
      assert.equal(result.data[1].query, 'first');
    });

    await t.test('omits keys with no metadata', async () => {
      const kv = {
        async list() {
          return {
            keys: [
              buildKvKey({ name: 'chat:a', query: 'q', response: 'r', timestamp: 't' }),
              { name: 'chat:b' }, // Missing metadata
            ],
            list_complete: true,
          };
        },
      };

      const result = await LogService.fetchLogs(kv, PAGINATION.DEFAULT_LIMIT, undefined);

      assert.equal(result.data.length, 1);
      assert.equal(result.data[0].id, 'chat:a');
    });

    await t.test('forwards cursor and limit to KV', async () => {
      let captured;
      const kv = {
        async list(opts) {
          captured = opts;
          return { keys: [], list_complete: true };
        },
      };

      await LogService.fetchLogs(kv, 5, 'cursor-token');

      assert.equal(captured.limit, 5);
      assert.equal(captured.cursor, 'cursor-token');
    });

    await t.test('reports has_more correctly', async () => {
      const kv = {
        async list() {
          return { keys: [], list_complete: false, cursor: 'next' };
        },
      };

      const result = await LogService.fetchLogs(kv, PAGINATION.DEFAULT_LIMIT, undefined);

      assert.equal(result.meta.has_more, true);
      assert.equal(result.meta.cursor, 'next');
      assert.equal(result.meta.limit, PAGINATION.DEFAULT_LIMIT);
    });
  });
});
