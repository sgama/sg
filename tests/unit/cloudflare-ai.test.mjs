import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudflareAi } from '../../scripts/lib/cloudflare-ai.mjs';
import { createSseMessageStream } from '../../functions/_lib/guardrails.js';

const options = { accountId: 'test-account', apiToken: 'test-token', namespace: 'corpus-test' };

test('Cloudflare adapter rejects missing credentials and candidate namespaces', () => {
    assert.throws(() => createCloudflareAi({ ...options, accountId: '' }), /CLOUDFLARE_ACCOUNT_ID/);
    assert.throws(() => createCloudflareAi({ ...options, namespace: '' }), /namespace/);
});

test('generation adapter posts streaming inputs with a timeout and returns raw SSE', async () => {
    let captured;
    const client = createCloudflareAi({
        ...options,
        async fetchImpl(url, init) {
            captured = { url, init };
            return new Response(createSseMessageStream('Answer'), { headers: { 'Content-Type': 'text/event-stream' } });
        },
    });
    const input = { messages: [{ role: 'user', content: 'Hi' }], stream: true };
    const stream = await client.run('@cf/test/model', input);
    assert.match(captured.url, /accounts\/test-account\/ai\/run\/@cf\/test\/model$/);
    assert.equal(captured.init.method, 'POST');
    assert.deepEqual(JSON.parse(captured.init.body), input);
    assert.ok(captured.init.signal instanceof AbortSignal);
    assert.match(await new Response(stream).text(), /Answer/);
});

test('generation adapter rejects upstream HTTP and nonstream response failures', async () => {
    const failed = createCloudflareAi({
        ...options, fetchImpl: async () => new Response('failure', { status: 429 }),
    });
    await assert.rejects(failed.run('@cf/test/model', {}), /HTTP 429/);
    const invalid = createCloudflareAi({
        ...options, fetchImpl: async () => Response.json({ result: { response: 'not SSE' } }),
    });
    await assert.rejects(invalid.run('@cf/test/model', {}), /did not return SSE/);
});
