import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { STORAGE_KEY } from '../../assets/js/chat/model/history.js';
import { createConversation, WELCOME_MESSAGE } from '../../assets/js/chat/model/conversation.js';

const METRICS = { totalMs: 1200, firstTokenMs: 300, estimatedLlmCostUsd: null, generationUsage: null };
const EXPLANATION = 'The response could not be completed. Please try again.';

function memoryStorage() {
    const data = new Map();
    return {
        data,
        get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
        set: (key, value) => data.set(key, value),
        remove: (key) => data.delete(key),
    };
}

// Stands in for the transport: each call is held open until the test settles it.
function controlledStream() {
    const calls = [];
    const streamAnswer = (query, options) =>
        new Promise((resolve, reject) => {
            calls.push({ query, options, resolve, reject });
            options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
    return { calls, streamAnswer };
}

function setup({ online = true } = {}) {
    const storage = memoryStorage();
    const stream = controlledStream();
    const logged = [];
    const controller = createConversation({
        storage,
        streamAnswer: stream.streamAnswer,
        isOnline: () => online,
        now: () => 0,
        log: { error: (...args) => logged.push(args) },
    });
    const events = [];
    controller.subscribe((event) => events.push(event));
    controller.load();
    return { controller, storage, stream, events, logged };
}

const settle = () => setImmediate();

test('saved history keeps only the newest 50 messages', () => {
    const { controller, storage } = setup();
    storage.set(
        STORAGE_KEY,
        Array.from({ length: 60 }, (_, i) => ({ sender: 'user', text: `old ${i}` })),
    );
    controller.load();
    controller.ask('newest');
    const saved = storage.data.get(STORAGE_KEY);
    assert.equal(saved.length, 50);
    assert.deepEqual(saved.at(-1), { text: 'newest', sender: 'user' });
    assert.equal(saved[0].text, 'old 11');
});

test('ask appends the question and an empty answer, persists them, and marks the controller busy', () => {
    const { controller, storage, stream, events } = setup();
    const active = controller.ask('  What is deployed?  ');
    const [, question, answer] = controller.messages;

    assert.equal(question.text, 'What is deployed?');
    assert.equal(answer.text, '');
    assert.equal(active.message, answer);
    assert.equal(controller.busy, true);
    assert.equal(stream.calls.length, 1);
    assert.equal(stream.calls[0].query, 'What is deployed?');
    assert.ok(events.some((event) => event.type === 'busy' && event.busy === true));
    // The empty placeholder answer is not persisted; only non-empty messages are saved.
    assert.deepEqual(storage.data.get(STORAGE_KEY).at(-1), { text: 'What is deployed?', sender: 'user' });
});

test('ask refuses blank input and a second question while one is in flight', () => {
    const { controller, stream } = setup();
    assert.equal(controller.ask('   '), null);
    assert.ok(controller.ask('first'));
    assert.equal(controller.ask('second'), null);
    assert.equal(stream.calls.length, 1);
});

test('streamed progress, evidence and metrics reach the message, and completion persists the answer', async () => {
    const { controller, storage, stream, events } = setup();
    controller.ask('Kubernetes?');
    const [{ options }] = stream.calls;

    options.onProgress('search');
    options.onEvidence([{ title: 'Resume', url: '/resume/', text: 'Ran clusters.' }]);
    options.onMetrics(METRICS);
    options.onUpdate('Partial');
    stream.calls[0].resolve('Final answer');
    await settle();

    const answer = controller.messages.at(-1);
    assert.equal(answer.text, 'Final answer');
    assert.deepEqual(answer.metrics, METRICS);
    assert.equal(answer.evidence[0].url, '/resume/');
    assert.equal(controller.busy, false);
    assert.equal(storage.data.get(STORAGE_KEY).at(-1).text, 'Final answer');
    assert.ok(events.some((event) => event.type === 'status' && event.text === 'Response complete.'));
    assert.ok(events.some((event) => event.type === 'stage' && event.request.stage === '🔎 Finding sources…'));
});

test('a failed request keeps the partial answer, offers a retry, and the retry reuses the prior history', async () => {
    const { controller, stream } = setup();
    controller.ask('First question');
    stream.calls[0].options.onUpdate('Half an answer');
    stream.calls[0].reject(new Error('network dropped'));
    await settle();

    const failed = controller.messages.at(-1);
    assert.equal(failed.text, `Half an answer\n\n${EXPLANATION}`);
    const retry = controller.retryFor(failed);
    assert.equal(retry.query, 'First question');

    controller.ask(retry.query, { retry });
    assert.equal(stream.calls[1].query, 'First question');
    assert.deepEqual(stream.calls[1].options.history, retry.history);
});

test('cancel keeps the partial answer and ignores callbacks that arrive afterwards', async () => {
    const { controller, stream, events } = setup();
    controller.ask('Stop me');
    const [{ options }] = stream.calls;
    options.onUpdate('Half');
    controller.cancel();
    await settle();

    const countAfterCancel = events.length;
    options.onUpdate('Late text');
    options.onProgress('generation');
    assert.equal(controller.messages.at(-1).text, 'Half\n\n(Response stopped.)');
    assert.equal(events.length, countAfterCancel);
    assert.equal(controller.busy, false);
});

test('invalid response metrics fail the request explicitly', async () => {
    const { controller, stream } = setup();
    controller.ask('Metrics?');
    assert.throws(() => stream.calls[0].options.onMetrics({}), /Invalid response metrics/);
    stream.calls[0].reject(new Error('Invalid response metrics'));
    await settle();
    assert.equal(controller.messages.at(-1).text, EXPLANATION);
});

test('clear cancels any request, resets to the welcome message and persists only that message', async () => {
    const { controller, storage, stream, events } = setup();
    controller.ask('Old question');
    stream.calls[0].resolve('Old answer');
    await settle();

    controller.clear();
    assert.deepEqual(controller.messages, [{ sender: 'bot', text: WELCOME_MESSAGE }]);
    assert.deepEqual(storage.data.get(STORAGE_KEY), [{ sender: 'bot', text: WELCOME_MESSAGE }]);
    assert.ok(events.some((event) => event.type === 'history:reset'));
    assert.ok(events.some((event) => event.type === 'status' && event.text === 'Chat history cleared.'));
});
