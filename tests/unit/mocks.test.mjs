import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeKv } from '../helpers/mocks.mjs';

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
