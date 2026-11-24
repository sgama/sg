import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOutputPart, wireEvents } from '../../shared/ai/chat-stream.js';
import { getModel } from '../../shared/ai/application.js';

const metrics = { firstToken() {}, snapshot: ({ model, usage }) => ({ model: model?.id, usage }) };
async function* parts(...items) {
    yield* items;
}
const collect = async (...items) => {
    const events = [];
    for await (const event of wireEvents(parts(...items), metrics)) events.push(event);
    return events;
};
const evidence = (url) => ({ title: url, url, text: 'x' });
const finish = { type: 'finish', totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };

test('isOutputPart treats only visible work as output', () => {
    for (const type of ['text-delta', 'reasoning-delta', 'tool-call', 'tool-result']) assert.equal(isOutputPart({ type }), true, type);
    for (const type of ['start', 'start-step', 'model', 'error', 'finish']) assert.equal(isOutputPart({ type }), false, type);
});

test('wireEvents accumulates evidence without repeating sources', async () => {
    const events = await collect(
        { type: 'tool-call' },
        { type: 'tool-result', output: { evidence: [evidence('/a/')] } },
        { type: 'tool-call' },
        { type: 'tool-result', output: { evidence: [evidence('/a/'), evidence('/b/')] } },
        { type: 'tool-result', output: { evidence: [evidence('/b/')] } },
        { type: 'text-delta', text: 'Hi' },
        finish,
    );
    assert.deepEqual(
        events.filter((event) => event.evidence).map((event) => event.evidence.map((item) => item.url)),
        [['/a/'], ['/a/', '/b/']],
    );
});

test('wireEvents maps parts to the widget wire events in order', async () => {
    const model = getModel('gemma');
    const events = await collect(
        { type: 'model', model },
        { type: 'tool-call' },
        { type: 'tool-result', output: { evidence: [evidence('/resume/')] } },
        { type: 'text-delta', text: ' ' },
        { type: 'text-delta', text: 'Answer' },
        { type: 'text-delta', text: '' },
        finish,
    );
    assert.deepEqual(events, [
        { progress: 'search' },
        { evidence: [evidence('/resume/')] },
        { progress: 'generation' },
        { response: ' ' },
        { response: 'Answer' },
        { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
        { metrics: { model: model.id, usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } },
    ]);
});

test('wireEvents marks the first non-blank token once', async () => {
    let first = 0;
    const counting = { ...metrics, firstToken: () => first++ };
    const items = [{ type: 'text-delta', text: '  ' }, { type: 'text-delta', text: 'a' }, { type: 'text-delta', text: 'b' }, finish];
    await Array.fromAsync(wireEvents(parts(...items), counting));
    assert.equal(first, 1);
});

test('wireEvents throws on aborts, stream errors, search failures and answerless streams', async () => {
    await assert.rejects(collect({ type: 'abort' }), /aborted/);
    await assert.rejects(collect({ type: 'error', error: new Error('boom') }), /boom/);
    await assert.rejects(collect({ type: 'error', error: 'text' }), /AI stream failed/);
    await assert.rejects(collect({ type: 'tool-error', error: new Error('search down') }), /search down/);
    await assert.rejects(collect({ type: 'text-delta', text: '  ' }, finish), /without an answer/);
    await assert.rejects(collect(finish), /without an answer/);
});
