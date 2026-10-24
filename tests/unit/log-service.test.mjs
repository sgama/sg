import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchChatLogs, saveChatLog } from '../../functions/_lib/log.js';
import { makeStream, drainStream, createContext } from '../helpers/mocks.mjs';
import { onRequest } from '../../functions/api/logs.js';

test('KV list failures reject and the logs API reports an explicit 500', async (t) => {
    const error = new Error('KV unavailable');
    const kv = {
        list: async () => {
            throw error;
        },
    };
    await assert.rejects(fetchChatLogs({ CHAT_LOGS: kv }, 10), (failure) => failure === error);
    const logged = t.mock.method(console, 'error', () => {});
    const response = await onRequest(
        createContext({
            url: 'https://example.com/api/logs',
            env: { CHAT_LOGS: kv },
        }),
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal Server Error' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(logged.mock.callCount(), 1);
    assert.deepEqual(logged.mock.calls[0].arguments, ['Logs API Error: KV unavailable']);
    logged.mock.restore();
});

test('KV read failures are skipped instead of failing the whole listing', async (t) => {
    const error = new Error('KV read rejected');
    const logged = t.mock.method(console, 'error', () => {});
    const kv = {
        list: async () => ({ keys: [{ name: 'record', metadata: { version: 2 } }], list_complete: true }),
        get: async () => {
            throw error;
        },
    };
    const result = await fetchChatLogs({ CHAT_LOGS: kv }, 10);
    assert.deepEqual(result.data, []);
    assert.equal(result.meta.count, 0);
    assert.ok(logged.mock.calls.some((call) => call.arguments[0] === 'Log record read failed:'));
    logged.mock.restore();
});

test('missing versioned records log an error and are omitted rather than fabricated', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const result = await fetchChatLogs(
        {
            CHAT_LOGS: {
                list: async () => ({
                    keys: [{ name: 'missing', metadata: { version: 2 } }],
                    list_complete: true,
                }),
                get: async () => null,
            },
        },
        10,
    );
    assert.deepEqual(result.data, []);
    assert.equal(result.meta.count, 0);
    assert.deepEqual(logged.mock.calls[0].arguments, ['Log record missing:', 'missing']);
    assert.equal(logged.mock.callCount(), 1);
});

test('stream error events persist partial answers and error identity', async () => {
    let payload;
    const stream = saveChatLog(
        {
            CHAT_LOGS: {
                put: async (_, value) => {
                    payload = JSON.parse(value);
                },
            },
        },
        'Question',
        makeStream('data: {"response":"Partial"}\n', 'data: {"error":"Provider failed"}\n'),
    );
    assert.match(await drainStream(stream), /Provider failed/);
    assert.equal(payload.response, 'Partial');
    assert.equal(payload.error, 'Provider failed');
});

test('write failures are logged once without breaking answer delivery or waitUntil', async (t) => {
    const failure = new Error('KV write rejected');
    const logged = t.mock.method(console, 'error', () => {});
    for (const background of [false, true]) {
        const pending = [];
        const stream = saveChatLog(
            {
                CHAT_LOGS: {
                    put: async () => {
                        throw failure;
                    },
                },
            },
            'Question',
            makeStream('data: {"response":"Answer"}\n', 'data: [DONE]\n'),
            background ? { waitUntil: (promise) => pending.push(promise) } : null,
        );
        assert.match(await drainStream(stream), /Answer/);
        await Promise.all(pending);
        assert.equal(pending.length, background ? 1 : 0);
    }
    assert.equal(logged.mock.callCount(), 2);
    assert.ok(logged.mock.calls.every((call) => call.arguments[0] === 'Log Flush Error' && call.arguments[1] === failure));
});

test('client disconnects persist the partial answer and cancel the upstream stream', async () => {
    let payload;
    let upstreamCancelReason;
    const encoder = new TextEncoder();
    const source = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode('data: {"response":"Partial"}\n\n'));
            // Deliberately never closes, simulating a still-open upstream connection.
        },
        cancel(reason) {
            upstreamCancelReason = reason;
        },
    });
    const stream = saveChatLog(
        {
            CHAT_LOGS: {
                put: async (_, value) => {
                    payload = JSON.parse(value);
                },
            },
        },
        'Question',
        source,
    );
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel('client aborted');
    assert.equal(payload.response, 'Partial');
    assert.equal(upstreamCancelReason, 'client aborted');
});
