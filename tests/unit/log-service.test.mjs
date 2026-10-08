import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LogService } from '../../functions/_lib/log.js';
import { buildKvKey, TIMESTAMPS, PAGINATION, FIXTURES } from '../helpers/data.mjs';
import { makeStream, drainStream, makeTimestamp, createContext, makeKv } from '../helpers/mocks.mjs';
import { onRequest } from '../../functions/api/logs.js';

/**
 * Unit tests for LogService
 * Tests stream passthrough, KV persistence, and log retrieval
 */

const now = makeTimestamp(TIMESTAMPS.FIXED_TS);
const id = () => 'test-id';

test('KV list and record reads reject and the logs API reports an explicit 500', async (t) => {
    const error = new Error('KV unavailable');
    for (const kv of [
        {
            list: async () => {
                throw error;
            },
        },
        {
            list: async () => ({ keys: [{ name: 'record', metadata: { version: 2 } }] }),
            get: async () => {
                throw error;
            },
        },
    ]) {
        await assert.rejects(LogService.fetchLogs(kv, 10), (failure) => failure === error);
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
    }
});

test('LogService', async (t) => {
    await t.test('fetchLogs', async (t) => {
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
        await t.test('rejects unversioned and unsupported records before reading values', async () => {
            for (const metadata of [undefined, {}, { query: 'old', response: 'old' }, { version: 1 }, { version: 3 }]) {
                const kv = {
                    list: async () => ({ keys: [{ name: 'chat:old', metadata }], list_complete: true }),
                    get: async () => assert.fail('Unsupported record must not be read'),
                };
                await assert.rejects(LogService.fetchLogs(kv, PAGINATION.DEFAULT_LIMIT), /Unsupported log record version: chat:old/);
            }
        });

        await t.test('reads full records from versioned values', async () => {
            const kv = {
                async list() {
                    return {
                        keys: [
                            {
                                name: 'chat:new',
                                metadata: { version: 2, timestamp: TIMESTAMPS.FIXED_TS },
                            },
                        ],
                        list_complete: true,
                    };
                },
                async get(name, type) {
                    assert.equal(name, 'chat:new');
                    assert.equal(type, 'json');
                    return { query: 'new', response: 'x'.repeat(5000) };
                },
            };
            const result = await LogService.fetchLogs(kv, 10);
            assert.equal(result.data[0].query, 'new');
            assert.equal(result.data[0].response.length, 5000);
            assert.equal(result.data.length, 1);
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

        await t.test('returns logs in reverse chronological order', async () => {
            const kv = makeKv({
                keys: [
                    buildKvKey({
                        name: 'chat:2026-01-01',
                        query: 'first',
                        response: 'a',
                        timestamp: '2026-01-01',
                    }),
                    buildKvKey({
                        name: 'chat:2026-01-02',
                        query: 'second',
                        response: 'b',
                        timestamp: '2026-01-02',
                    }),
                ],
            });

            const result = await LogService.fetchLogs(kv, PAGINATION.DEFAULT_LIMIT, undefined);

            assert.equal(result.data[0].query, 'second');
            assert.equal(result.data[1].query, 'first');
        });
    });

    await t.test('save', async (t) => {
        await t.test('KV persistence', async (t) => {
            await t.test('captures usage metadata when present in SSE payload', async () => {
                const saved = [];
                const kv = { put: async (k, v) => saved.push(JSON.parse(v)) };

                const stream = makeStream(
                    'data: {"response":"text"}\n',
                    `data: {"usage":${JSON.stringify(FIXTURES.USAGE_STATS)}}\n`,
                    'data: [DONE]\n',
                );

                const piped = await LogService.save(kv, 'q', stream, null, { now });
                await drainStream(piped);

                assert.deepEqual(saved[0].usage, FIXTURES.USAGE_STATS);
            });

            await t.test('keeps long answers out of metadata and gives same-time requests unique keys', async () => {
                const saved = [];
                const kv = {
                    put: async (key, value, options) => saved.push({ key, value, options }),
                };
                for (let i = 0; i < 2; i++) {
                    const piped = await LogService.save(kv, 'q', makeStream(`data: ${JSON.stringify({ response: 'x'.repeat(5000) })}\n`), null, {
                        now,
                    });
                    await drainStream(piped);
                }
                assert.notEqual(saved[0].key, saved[1].key);
                assert.equal(JSON.parse(saved[0].value).response.length, 5000);
                assert.ok(new TextEncoder().encode(JSON.stringify(saved[0].options.metadata)).length < 1024);
            });

            await t.test('persists full response in the value and small versioned metadata', async () => {
                const saved = [];
                const kv = {
                    async put(key, value, options) {
                        saved.push({ key, value, metadata: options?.metadata });
                    },
                };

                const stream = makeStream('data: {"response":"Hello"}\n', 'data: {"response":" world"}\n', 'data: [DONE]\n');

                const piped = await LogService.save(kv, 'test query', stream, null, {
                    now,
                    id,
                });
                await drainStream(piped);

                assert.equal(saved.length, 1);
                assert.equal(saved[0].key, `chat:${TIMESTAMPS.FIXED_TS}:test-id`);
                assert.equal(JSON.parse(saved[0].value).query, 'test query');
                assert.equal(JSON.parse(saved[0].value).response, 'Hello world');
                assert.equal(saved[0].metadata.timestamp, TIMESTAMPS.FIXED_TS);
                assert.deepEqual(saved[0].metadata, {
                    timestamp: TIMESTAMPS.FIXED_TS,
                    version: 2,
                });
            });

            await t.test('tolerates malformed JSON in SSE data lines', async () => {
                const saved = [];
                const kv = { put: async (k, v) => saved.push(JSON.parse(v)) };

                const stream = makeStream('data: {"response":"ok"}\n', 'data: {broken json\n', 'data: [DONE]\n');

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

        await t.test('Passthrough behavior', async (t) => {
            await t.test('passes all chunks through to readable side unchanged', async () => {
                const kv = { put: async () => {} };
                const stream = makeStream('data: {"response":"Hello"}\n', 'data: {"response":" world"}\n', 'data: [DONE]\n');

                const piped = await LogService.save(kv, 'q', stream, null, { now });
                const output = await drainStream(piped);

                assert.match(output, /Hello/);
                assert.match(output, /world/);
                assert.match(output, /\[DONE\]/);
            });

            await t.test('returns original stream unchanged when kv is falsy', async () => {
                const original = makeStream('data: {"response":"hi"}\n', 'data: [DONE]\n');
                const result = await LogService.save(null, 'query', original, null, { now });

                assert.equal(result, original);
            });
        });
    });
});

test('missing versioned records log an error and are omitted rather than fabricated', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const result = await LogService.fetchLogs(
        {
            list: async () => ({
                keys: [{ name: 'missing', metadata: { version: 2 } }],
                list_complete: true,
            }),
            get: async () => null,
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
    const stream = await LogService.save(
        {
            put: async (_, value) => {
                payload = JSON.parse(value);
            },
        },
        'Question',
        makeStream('data: {"response":"Partial"}', 'data: {"error":"Provider failed"}'),
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
        const stream = await LogService.save(
            {
                put: async () => {
                    throw failure;
                },
            },
            'Question',
            makeStream('data: {"response":"Answer"}', 'data: [DONE]'),
            background ? { waitUntil: (promise) => pending.push(promise) } : null,
        );
        assert.match(await drainStream(stream), /Answer/);
        await Promise.all(pending);
        assert.equal(pending.length, background ? 1 : 0);
    }
    assert.equal(logged.mock.callCount(), 2);
    assert.ok(logged.mock.calls.every((call) => call.arguments[0] === 'Log Flush Error' && call.arguments[1] === failure));
});
