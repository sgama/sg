import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../../functions/api/logs.js';

function makeKv({ keys = [], cursor = undefined, list_complete = true } = {}) {
    return {
        async list({ prefix, limit, cursor: inputCursor } = {}) {
            return { keys, cursor, list_complete };
        }
    };
}

function createContext({ method = 'GET', url = 'https://example.com/api/logs', env = {} } = {}) {
    return {
        request: new Request(url, { method }),
        env,
    };
}

test('rejects non-GET requests', async () => {
    const res = await onRequest(createContext({ method: 'POST', env: { CHAT_LOGS: makeKv() } }));
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(body.error, 'Method not allowed');
});

test('returns 503 when KV binding is missing', async () => {
    const res = await onRequest(createContext({ env: {} }));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.ok(body.error.includes('KV binding missing'));
});

test('returns empty data when KV has no keys', async () => {
    const res = await onRequest(createContext({ env: { CHAT_LOGS: makeKv() } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, []);
    assert.equal(body.meta.count, 0);
    assert.equal(body.meta.has_more, false);
});

test('returns logs from KV metadata', async () => {
    const keys = [
        { name: 'chat:2026-01-01T00:00:00.000Z', metadata: { timestamp: '2026-01-01T00:00:00.000Z', query: 'hello', response: 'hi', usage: null } },
        { name: 'chat:2026-01-02T00:00:00.000Z', metadata: { timestamp: '2026-01-02T00:00:00.000Z', query: 'world', response: 'yes', usage: null } },
    ];
    const res = await onRequest(createContext({ env: { CHAT_LOGS: makeKv({ keys }) } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 2);
    // reverse() puts latest first
    assert.equal(body.data[0].id, 'chat:2026-01-02T00:00:00.000Z');
    assert.equal(body.data[0].query, 'world');
    assert.equal(body.data[1].query, 'hello');
});

test('skips keys with no metadata', async () => {
    const keys = [
        { name: 'chat:a', metadata: { timestamp: 't', query: 'q', response: 'r', usage: null } },
        { name: 'chat:b' }, // no metadata
    ];
    const res = await onRequest(createContext({ env: { CHAT_LOGS: makeKv({ keys }) } }));
    const body = await res.json();
    assert.equal(body.data.length, 1);
});

test('uses default limit when limit param is absent', async () => {
    let capturedLimit;
    const kv = {
        async list({ limit }) {
            capturedLimit = limit;
            return { keys: [], list_complete: true };
        }
    };
    await onRequest(createContext({ env: { CHAT_LOGS: kv } }));
    assert.equal(capturedLimit, 20); // CONFIG.PAGINATION.DEFAULT_LIMIT
});

test('uses provided limit when valid', async () => {
    let capturedLimit;
    const kv = {
        async list({ limit }) {
            capturedLimit = limit;
            return { keys: [], list_complete: true };
        }
    };
    await onRequest(createContext({
        url: 'https://example.com/api/logs?limit=5',
        env: { CHAT_LOGS: kv }
    }));
    assert.equal(capturedLimit, 5);
});

test('clamps limit to MAX_LIMIT', async () => {
    let capturedLimit;
    const kv = {
        async list({ limit }) {
            capturedLimit = limit;
            return { keys: [], list_complete: true };
        }
    };
    await onRequest(createContext({
        url: 'https://example.com/api/logs?limit=999',
        env: { CHAT_LOGS: kv }
    }));
    assert.equal(capturedLimit, 20); // falls back to default when over MAX_LIMIT (50)
});

test('forwards cursor param to KV list', async () => {
    let capturedCursor;
    const kv = {
        async list({ cursor }) {
            capturedCursor = cursor;
            return { keys: [], list_complete: true };
        }
    };
    await onRequest(createContext({
        url: 'https://example.com/api/logs?cursor=abc123',
        env: { CHAT_LOGS: kv }
    }));
    assert.equal(capturedCursor, 'abc123');
});

test('exposes has_more and cursor in meta', async () => {
    const kv = makeKv({ keys: [], cursor: 'next-page', list_complete: false });
    const res = await onRequest(createContext({ env: { CHAT_LOGS: kv } }));
    const body = await res.json();
    assert.equal(body.meta.has_more, true);
    assert.equal(body.meta.cursor, 'next-page');
});

test('sets correct response headers', async () => {
    const res = await onRequest(createContext({ env: { CHAT_LOGS: makeKv() } }));
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});
