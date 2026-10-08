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
const normalize = async (text, fragmentSize) => new Response(normalizeChatStream(streamOf(text, fragmentSize))).text();

test('finishes a valid answer when upstream closes without a DONE event', async () => {
    assert.equal(await normalize(event(delta('Answer'))), event({ response: 'Answer' }) + 'data: [DONE]\n\n');
});

test('normalizes GLM deltas, strips reasoning, and preserves final aggregate usage', async () => {
    const usage = { prompt_tokens: 1195, completion_tokens: 787, total_tokens: 1982 };
    const input =
        event({
            choices: [{ index: 0, delta: { reasoning: 'private', reasoning_content: 'private' } }],
        }) +
        event({ ...delta('Hello '), usage: { completion_tokens: 1 } }) +
        event(delta('world')) +
        event({ choices: [], usage: { total_tokens: 0 } }) +
        event({ choices: [], usage }) +
        'data: [DONE]\n\n';

    assert.equal(await normalize(input), event({ response: 'Hello ' }) + event({ response: 'world' }) + event({ usage }) + 'data: [DONE]\n\n');
});

test('preserves a standalone OpenAI aggregate usage event without chunk-usage inflation', async () => {
    const usage = { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 };
    const input = event(delta('Answer')) + event({ choices: [], usage }) + 'data: [DONE]\n\n';
    assert.equal(await normalize(input), event({ response: 'Answer' }) + event({ usage }) + 'data: [DONE]\n\n');
});

test('accepts the current Workers binding usage summary only after content deltas', async () => {
    const usage = { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 };
    const input = event(delta('Answer')) + event({ response: '', usage }) + 'data: [DONE]\n\n';
    assert.equal(await normalize(input), event({ response: 'Answer' }) + event({ usage }) + 'data: [DONE]\n\n');
});

test('creates the current widget response stream directly', async () => {
    const output = await new Response(createSseMessageStream('Answer')).text();
    assert.equal(output, event({ response: 'Answer' }) + 'data: [DONE]\n\n');
});

test('propagates upstream stream failures', async () => {
    const upstream = new ReadableStream({
        start(controller) {
            controller.error(new Error('upstream disconnected'));
        },
    });
    await assert.rejects(new Response(normalizeChatStream(upstream)).text(), /upstream disconnected/);
});

test('reports reasoning-only, empty, malformed, and provider-error streams explicitly', async (t) => {
    const cases = [
        {
            name: 'reasoning-only',
            input: event({ choices: [{ index: 0, delta: { reasoning_content: 'private' } }] }) + 'data: [DONE]\n\n',
            errorType: Error,
            message: /^AI stream completed without an answer$/,
        },
        {
            name: 'legacy response',
            input: event({ response: 'Legacy answer' }),
            errorType: Error,
            message: /^Unsupported AI stream event: expected choices$/,
        },
        {
            name: 'usage summary without preceding content deltas',
            input: event({ response: '', usage: { total_tokens: 20 } }),
            errorType: Error,
            message: /^Unsupported AI stream event: expected choices$/,
        },
        {
            name: 'empty',
            input: '',
            errorType: Error,
            message: /^AI stream completed without an answer$/,
        },
        {
            name: 'malformed JSON',
            input: 'data: {bad json}\n\n',
            errorType: SyntaxError,
            message: /JSON/,
        },
        {
            name: 'provider error',
            input: event({ error: { message: 'provider failed' } }),
            errorType: Error,
            message: /^AI returned a streaming error$/,
        },
    ];
    for (const { name, input, errorType, message } of cases) {
        await t.test(name, async (t) => {
            const logged = t.mock.method(console, 'error', () => {});
            assert.equal(await normalize(input), event({ error: 'AI response failed. Please try again.' }) + 'data: [DONE]\n\n');
            assert.equal(logged.mock.callCount(), 1);
            const [label, failure] = logged.mock.calls[0].arguments;
            assert.equal(logged.mock.calls[0].arguments.length, 2);
            assert.equal(label, 'Chat Stream Failed:');
            assert.ok(failure instanceof errorType);
            assert.match(failure.message, message);
        });
    }
});

test('supports CRLF, SSE comments, multiline data, and byte-fragmented UTF-8', async () => {
    const input = ': heartbeat\r\n\r\ndata: {"choices":\r\n' + 'data: [{"index":0,"delta":{"content":"Hi \u{1f44b}"}}]}\r\n\r\n' + 'data: [DONE]';
    assert.equal(await normalize(input, 1), event({ response: 'Hi \u{1f44b}' }) + 'data: [DONE]\n\n');
});
