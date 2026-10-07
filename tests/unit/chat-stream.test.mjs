import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChatStream, createSseMessageStream } from '../../functions/_lib/chat-stream.js';

const event = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const delta = (content) => ({ choices: [{ index: 0, delta: { content } }] });
const streamOf = (text, fragmentSize = 7) => {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream({
        start(controller) {
            for (let i = 0; i < bytes.length; i += fragmentSize) {
                controller.enqueue(bytes.slice(i, i + fragmentSize));
            }
            controller.close();
        },
    });
};
const normalize = async (text, fragmentSize) =>
    new Response(normalizeChatStream(streamOf(text, fragmentSize))).text();

test('normalizes GLM deltas, strips reasoning, and preserves final aggregate usage', async () => {
    const usage = { prompt_tokens: 1195, completion_tokens: 787, total_tokens: 1982 };
    const input = event({ choices: [{ index: 0, delta: { reasoning: 'private', reasoning_content: 'private' } }] })
        + event({ ...delta('Hello '), usage: { completion_tokens: 1 } })
        + event(delta('world'))
        + event({ choices: [], usage: { total_tokens: 0 } })
        + event({ response: '', usage })
        + 'data: [DONE]\n\n';

    assert.equal(await normalize(input),
        event({ response: 'Hello ' }) + event({ response: 'world' })
        + event({ usage }) + 'data: [DONE]\n\n');
});

test('supports CRLF, SSE comments, multiline data, and byte-fragmented UTF-8', async () => {
    const input = ': heartbeat\r\n\r\ndata: {"choices":\r\n'
        + 'data: [{"index":0,"delta":{"content":"Hi \u{1f44b}"}}]}\r\n\r\n'
        + 'data: [DONE]';
    assert.equal(await normalize(input, 1),
        event({ response: 'Hi \u{1f44b}' }) + 'data: [DONE]\n\n');
});

test('preserves the legacy response stream contract', async () => {
    const output = await new Response(normalizeChatStream(createSseMessageStream('Legacy answer'))).text();
    assert.equal(output, event({ response: 'Legacy answer' }) + 'data: [DONE]\n\n');
});

test('preserves a standalone OpenAI aggregate usage event without chunk-usage inflation', async () => {
    const usage = { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 };
    const input = event(delta('Answer'))
        + event({ choices: [], usage }) + 'data: [DONE]\n\n';
    assert.equal(await normalize(input),
        event({ response: 'Answer' }) + event({ usage }) + 'data: [DONE]\n\n');
});

test('does not duplicate content when provider emits a final response summary', async () => {
    const input = event(delta('Answer')) + event({ response: 'Answer' }) + 'data: [DONE]\n\n';
    assert.equal(await normalize(input), event({ response: 'Answer' }) + 'data: [DONE]\n\n');
});

test('finishes a valid answer when upstream closes without a DONE event', async () => {
    assert.equal(await normalize(event(delta('Answer'))),
        event({ response: 'Answer' }) + 'data: [DONE]\n\n');
});

test('reports reasoning-only, empty, malformed, and provider-error streams explicitly', async (t) => {
    const inputs = [
        event({ choices: [{ index: 0, delta: { reasoning_content: 'private' } }] })
            + event({ response: '' }) + 'data: [DONE]\n\n',
        '',
        'data: {bad json}\n\n',
        event({ error: { message: 'provider failed' } }),
    ];
    for (const [index, input] of inputs.entries()) {
        await t.test(`failure ${index}`, async () => {
            assert.equal(await normalize(input),
                event({ error: 'AI response failed. Please try again.' }) + 'data: [DONE]\n\n');
        });
    }
});

test('propagates upstream stream failures', async () => {
    const upstream = new ReadableStream({
        start(controller) {
            controller.error(new Error('upstream disconnected'));
        },
    });
    await assert.rejects(new Response(normalizeChatStream(upstream)).text(), /upstream disconnected/);
});
