/**
 * Unit tests for /api/logs endpoint
 * Tests log retrieval with pagination, validation, and error handling
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../../functions/api/logs.js';
import {
  makeKv,
  createContext,
  buildKvKey,
  PAGINATION,
  TIMESTAMPS,
  URLS,
} from '../helpers/index.mjs';

test('/api/logs', async (t) => {
  await t.test('Request validation', async (t) => {
    await t.test('rejects non-GET requests', async () => {
      const res = await onRequest(createContext({
        method: 'POST',
        url: `${URLS.TEST_API_ENDPOINT}/logs`,
        env: { CHAT_LOGS: makeKv() },
      }));

      assert.equal(res.status, 405);
      const body = await res.json();
      assert.ok(body.error.includes('Method not allowed'));
    });

    await t.test('returns 503 when KV binding is missing', async () => {
      const res = await onRequest(createContext({
        method: 'GET',
        url: `${URLS.TEST_API_ENDPOINT}/logs`,
        env: {},
      }));

      assert.equal(res.status, 503);
      const body = await res.json();
      assert.ok(body.error.includes('KV binding missing'));
    });
  });

  await t.test('Data retrieval', async (t) => {
    await t.test('returns empty data when KV has no keys', async () => {
      const res = await onRequest(createContext({
        method: 'GET',
        url: `${URLS.TEST_API_ENDPOINT}/logs`,
        env: { CHAT_LOGS: makeKv() },
      }));

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.data, []);
      assert.equal(body.meta.count, 0);
      assert.equal(body.meta.limit, PAGINATION.DEFAULT_LIMIT);
      assert.equal(body.meta.has_more, false);
    });

    await t.test('returns logs from KV metadata in reverse chronological order', async () => {
      const keys = [
        buildKvKey({ name: 'chat:2026-01-01T00:00:00.000Z', query: 'hello', response: 'hi', timestamp: TIMESTAMPS.FIXED_TS }),
        buildKvKey({ name: 'chat:2026-01-02T00:00:00.000Z', query: 'world', response: 'yes', timestamp: TIMESTAMPS.FIXED_TS_2 }),
      ];
      const res = await onRequest(createContext({
        method: 'GET',
        url: `${URLS.TEST_API_ENDPOINT}/logs`,
        env: { CHAT_LOGS: makeKv({ keys }) },
      }));

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.length, 2);
      // reverse() puts latest first
      assert.equal(body.data[0].id, 'chat:2026-01-02T00:00:00.000Z');
      assert.equal(body.data[0].query, 'world');
      assert.equal(body.data[1].query, 'hello');
    });

    await t.test('skips keys with no metadata', async () => {
      const keys = [
        buildKvKey({ name: 'chat:a', query: 'q', response: 'r', timestamp: 't' }),
        { name: 'chat:b' }, // no metadata
      ];
      const res = await onRequest(createContext({
        method: 'GET',
        url: `${URLS.TEST_API_ENDPOINT}/logs`,
        env: { CHAT_LOGS: makeKv({ keys }) },
      }));

      const body = await res.json();
      assert.equal(body.data.length, 1);
    });
  });

  await t.test('Pagination', async (t) => {
    await t.test('uses default limit when limit param is absent', async () => {
      let capturedLimit;
      const kv = {
        async list({ limit }) {
          capturedLimit = limit;
          return { keys: [], list_complete: true };
        }
      };

      await onRequest(createContext({
        method: 'GET',
        url: `${URLS.TEST_API_ENDPOINT}/logs`,
        env: { CHAT_LOGS: kv },
      }));

      assert.equal(capturedLimit, PAGINATION.DEFAULT_LIMIT);
    });

    await t.test('uses provided limit when valid', async () => {
      let capturedLimit;
      const kv = {
        async list({ limit }) {
          capturedLimit = limit;
          return { keys: [], list_complete: true };
        }
      };

      await onRequest(createContext({
        method: 'GET',
        url: `${URLS.TEST_API_ENDPOINT}/logs?limit=5`,
        env: { CHAT_LOGS: kv },
      }));

      assert.equal(capturedLimit, 5);
    });

    await t.test('echoes limit in meta response', async () => {
      const res = await onRequest(createContext({
        method: 'GET',
        url: `${URLS.TEST_API_ENDPOINT}/logs?limit=10`,
        env: { CHAT_LOGS: makeKv() },
      }));

      const body = await res.json();
      assert.equal(body.meta.limit, 10);
    });

    await t.test('clamps limit to DEFAULT_LIMIT when exceeding MAX_LIMIT', async () => {
      let capturedLimit;
      const kv = {
        async list({ limit }) {
          capturedLimit = limit;
          return { keys: [], list_complete: true };
        }
      };

      await onRequest(createContext({
        method: 'GET',
        url: `${URLS.TEST_API_ENDPOINT}/logs?limit=999`,
        env: { CHAT_LOGS: kv },
      }));

      // Falls back to default when over MAX_LIMIT (50)
      assert.equal(capturedLimit, PAGINATION.DEFAULT_LIMIT);
    });

    await t.test('forwards cursor param to KV list', async () => {
      let capturedCursor;
      const kv = {
        async list({ cursor }) {
          capturedCursor = cursor;
          return { keys: [], list_complete: true };
        }
      };

      await onRequest(createContext({
        method: 'GET',
        url: `${URLS.TEST_API_ENDPOINT}/logs?cursor=abc123`,
        env: { CHAT_LOGS: kv },
      }));

      assert.equal(capturedCursor, 'abc123');
    });

    await t.test('exposes has_more and cursor in meta', async () => {
      const kv = makeKv({ keys: [], cursor: 'next-page', list_complete: false });
      const res = await onRequest(createContext({
        method: 'GET',
        url: `${URLS.TEST_API_ENDPOINT}/logs`,
        env: { CHAT_LOGS: kv },
      }));

      const body = await res.json();
      assert.equal(body.meta.has_more, true);
      assert.equal(body.meta.cursor, 'next-page');
    });
  });

  await t.test('Response headers', async (t) => {
    await t.test('sets correct security and cache headers', async () => {
      const res = await onRequest(createContext({
        method: 'GET',
        url: `${URLS.TEST_API_ENDPOINT}/logs`,
        env: { CHAT_LOGS: makeKv() },
      }));

      assert.match(res.headers.get('Content-Type'), /application\/json/);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
      assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    });
  });
});
