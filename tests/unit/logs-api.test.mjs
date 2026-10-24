/**
 * Unit tests for /api/logs endpoint
 * Tests log retrieval with pagination, validation, and error handling
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../helpers/worker.mjs';
import { buildKvKey, PAGINATION, TIMESTAMPS, URLS } from '../helpers/data.mjs';
import { makeKv, createContext } from '../helpers/mocks.mjs';

test('/api/logs', async (t) => {
    await t.test('Data retrieval', async (t) => {
        await t.test('returns empty data when KV has no keys', async () => {
            const res = await onRequest(
                createContext({
                    method: 'GET',
                    url: `${URLS.TEST_API_ENDPOINT}/logs`,
                    env: { CHAT_LOGS: makeKv() },
                }),
            );

            assert.equal(res.status, 200);
            const body = await res.json();
            assert.deepEqual(body.data, []);
            assert.equal(body.meta.count, 0);
            assert.equal(body.meta.limit, PAGINATION.DEFAULT_LIMIT);
            assert.equal(body.meta.has_more, false);
        });

        await t.test('returns versioned KV values in reverse chronological order', async () => {
            const keys = [
                buildKvKey({
                    name: 'chat:2026-01-01T00:00:00.000Z',
                    query: 'hello',
                    response: 'hi',
                    timestamp: TIMESTAMPS.FIXED_TS,
                }),
                buildKvKey({
                    name: 'chat:2026-01-02T00:00:00.000Z',
                    query: 'world',
                    response: 'yes',
                    timestamp: TIMESTAMPS.FIXED_TS_2,
                }),
            ];
            const res = await onRequest(
                createContext({
                    method: 'GET',
                    url: `${URLS.TEST_API_ENDPOINT}/logs`,
                    env: { CHAT_LOGS: makeKv({ keys }) },
                }),
            );

            assert.equal(res.status, 200);
            const body = await res.json();
            assert.equal(body.data.length, 2);
            // reverse() puts latest first
            assert.equal(body.data[0].id, 'chat:2026-01-02T00:00:00.000Z');
            assert.equal(body.data[0].query, 'world');
            assert.equal(body.data[1].query, 'hello');
        });

        await t.test('skips unsupported log formats explicitly', async (t) => {
            const logged = t.mock.method(console, 'error', () => {});
            const keys = [{ name: 'chat:old', metadata: { query: 'q', response: 'r' } }];
            const res = await onRequest(
                createContext({
                    method: 'GET',
                    url: `${URLS.TEST_API_ENDPOINT}/logs`,
                    env: { CHAT_LOGS: makeKv({ keys }) },
                }),
            );

            const body = await res.json();
            assert.equal(res.status, 200);
            assert.deepEqual(body.data, []);
            assert.equal(body.meta.count, 0);
            assert.equal(logged.mock.callCount(), 1);
            assert.deepEqual(logged.mock.calls[0].arguments, ['Unsupported log record version:', 'chat:old']);
        });
    });

    await t.test('Pagination', async (t) => {
        await t.test('parses the limit query param: absent, valid, and out-of-range', async () => {
            for (const [query, expected] of [
                ['', PAGINATION.DEFAULT_LIMIT],
                ['?limit=5', 5],
                ['?limit=999', PAGINATION.DEFAULT_LIMIT], // falls back to default when over MAX_LIMIT (50)
            ]) {
                let capturedLimit;
                const kv = {
                    async list({ limit }) {
                        capturedLimit = limit;
                        return { keys: [], list_complete: true };
                    },
                };

                await onRequest(
                    createContext({
                        method: 'GET',
                        url: `${URLS.TEST_API_ENDPOINT}/logs${query}`,
                        env: { CHAT_LOGS: kv },
                    }),
                );

                assert.equal(capturedLimit, expected);
            }
        });

        await t.test('forwards cursor param to KV list', async () => {
            let capturedCursor;
            const kv = {
                async list({ cursor }) {
                    capturedCursor = cursor;
                    return { keys: [], list_complete: true };
                },
            };

            await onRequest(
                createContext({
                    method: 'GET',
                    url: `${URLS.TEST_API_ENDPOINT}/logs?cursor=abc123`,
                    env: { CHAT_LOGS: kv },
                }),
            );

            assert.equal(capturedCursor, 'abc123');
        });

        await t.test('echoes limit and KV pagination metadata in the response', async () => {
            const kv = makeKv({ keys: [], cursor: 'next-page', list_complete: false });
            const res = await onRequest(
                createContext({
                    method: 'GET',
                    url: `${URLS.TEST_API_ENDPOINT}/logs?limit=10`,
                    env: { CHAT_LOGS: kv },
                }),
            );

            const body = await res.json();
            assert.equal(body.meta.limit, 10);
            assert.equal(body.meta.has_more, true);
            assert.equal(body.meta.cursor, 'next-page');
        });
    });

    await t.test('Request validation', async (t) => {
        await t.test('rejects non-GET requests', async () => {
            const res = await onRequest(
                createContext({
                    method: 'POST',
                    url: `${URLS.TEST_API_ENDPOINT}/logs`,
                    env: { CHAT_LOGS: makeKv() },
                }),
            );

            assert.equal(res.status, 405);
            const body = await res.json();
            assert.ok(body.error.includes('Method not allowed'));
        });

        await t.test('returns 503 when KV binding is missing', async () => {
            const res = await onRequest(
                createContext({
                    method: 'GET',
                    url: `${URLS.TEST_API_ENDPOINT}/logs`,
                    env: {},
                }),
            );

            assert.equal(res.status, 503);
            const body = await res.json();
            assert.ok(body.error.includes('KV binding missing'));
        });
    });

    await t.test('Response headers', async (t) => {
        await t.test('sets correct security and cache headers', async () => {
            const res = await onRequest(
                createContext({
                    method: 'GET',
                    url: `${URLS.TEST_API_ENDPOINT}/logs`,
                    env: { CHAT_LOGS: makeKv() },
                }),
            );

            assert.match(res.headers.get('Content-Type'), /application\/json/);
            assert.equal(res.headers.get('Cache-Control'), 'no-store');
            assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
        });
    });
});
