import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drainStream, makeKv } from '../helpers/mocks.mjs';

test('KV mocks reject unconfigured writes and forward configured write arguments', async (t) => {
    await assert.rejects(makeKv().put('key', 'value'), /KV.put not configured/);
    const put = t.mock.fn(async () => {});
    const kv = makeKv({ put });
    const options = { expirationTtl: 60 };
    await kv.put('key', 'value', options);
    assert.equal(put.mock.callCount(), 1);
    assert.deepEqual(put.mock.calls[0].arguments, ['key', 'value', options]);
    assert.deepEqual(await kv.list(), { keys: [], cursor: undefined, list_complete: true });
});

test('native stream reading handles fragmented UTF-8 and flushes incomplete bytes', async () => {
    const bytes = new TextEncoder().encode('A\u20ac');
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(bytes.slice(0, 2));
            controller.enqueue(bytes.slice(2));
            controller.enqueue(Uint8Array.of(0xe2));
            controller.close();
        },
    });
    assert.equal(await drainStream(stream), 'A\u20ac\ufffd');
});

test('native stream reading propagates stream failures', async () => {
    const stream = new ReadableStream({
        start(controller) {
            controller.error(new Error('broken stream'));
        },
    });
    await assert.rejects(drainStream(stream), /broken stream/);
});
