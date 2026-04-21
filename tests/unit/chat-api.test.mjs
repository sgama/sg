import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../../functions/api/chat.js';

function createSseStream(payload = 'Hello from AI') {
    const encoder = new TextEncoder();

    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: payload })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        }
    });
}

function createContext({ method = 'POST', body, env = {}, waitUntil } = {}) {
    const request = new Request('https://example.com/api/chat', {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return {
        request,
        env,
        ...(waitUntil ? { waitUntil } : {}),
    };
}

test('returns CORS headers for OPTIONS requests', async () => {
    const response = await onRequest(createContext({ method: 'OPTIONS' }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
    assert.equal(response.headers.get('Access-Control-Max-Age'), '86400');
});

test('rejects blank queries after trimming whitespace', async () => {
    const response = await onRequest(createContext({ body: { query: '   ' } }));

    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.deepEqual(await response.json(), {
        error: 'Invalid query. Must be a string < 500 chars.'
    });
});

test('returns 503 when AI binding is missing', async () => {
    const response = await onRequest(createContext({ body: { query: 'hello' } }));

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
        error: 'Service Unavailable: AI binding missing'
    });
});

test('passes trimmed query and sanitized history into generation', async () => {
    const calls = [];
    const env = {
        AI: {
            async run(model, payload) {
                calls.push({ model, payload });
                return createSseStream();
            }
        }
    };

    const response = await onRequest(createContext({
        env,
        body: {
            query: '  What do you build?  ',
            history: [
                { role: 'system', content: 'drop me' },
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Hello there' },
                { role: 'assistant', content: '' },
                { role: 'user', content: 'x'.repeat(2100) },
                { role: 'user', content: 'Tell me more' },
            ]
        }
    }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.messages.at(-1).content, 'What do you build?');
    assert.deepEqual(calls[0].payload.messages.slice(1, -1), [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello there' },
        { role: 'user', content: 'Tell me more' },
    ]);
});

test('logs streamed output to KV when CHAT_LOGS is configured', async () => {
    const savedEntries = [];
    const pending = [];
    const env = {
        AI: {
            async run() {
                return createSseStream('Logged response');
            }
        },
        CHAT_LOGS: {
            async put(key, value) {
                savedEntries.push({ key, value: JSON.parse(value) });
            }
        }
    };

    const response = await onRequest(createContext({
        env,
        waitUntil(promise) {
            pending.push(promise);
        },
        body: { query: 'Persist this' }
    }));

    await response.text();
    await Promise.all(pending);

    assert.equal(savedEntries.length, 1);
    assert.ok(savedEntries[0].key.startsWith('chat:'));
    assert.equal(savedEntries[0].value.query, 'Persist this');
    assert.equal(savedEntries[0].value.response, 'Logged response');
});