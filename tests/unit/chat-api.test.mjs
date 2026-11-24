/**
 * Unit tests for /api/chat: CORS, validation, limits, and the streamed chat turn against a scripted model and a fake AI Search instance.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatApp } from '../../functions/_lib/chat-app.js';
import { runTurn } from '../../functions/_lib/agent.js';
import { onRequest } from '../helpers/worker.mjs';
import { FIXTURES, URLS } from '../helpers/data.mjs';
import { answerStep, createContext, failingStep, fakeSearchInstance, scriptedModel, searchChunk, searchStep, sseEvents } from '../helpers/mocks.mjs';

const ENV = { AI: {}, AI_SEARCH: {}, AI_SEARCH_INSTANCE: 'portfolio-test' };
const RESUME = searchChunk({ text: 'Senior engineer at Bitcomplete 2020-2024.', title: 'Resume', url: '/resume/' });

/** An app whose chat turn runs the real agent against scripted models (by registry model id) and a fake instance. */
function appWith({ models, instance = fakeSearchInstance([RESUME]) }) {
    return createChatApp({
        runTurn: (turn) => runTurn({ ...turn, languageModel: (model) => models[model.id] ?? models.default, instance }),
    });
}

const post = (app, body = { query: 'What did Samson do last?' }, { env = ENV, signal } = {}) =>
    app.request(
        '/api/chat',
        new Request(`${URLS.TEST_API_ENDPOINT}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: URLS.ALLOWED_ORIGIN },
            body: JSON.stringify(body),
            signal,
        }),
        env,
        { waitUntil() {} },
    );

test('/api/chat', async (t) => {
    await t.test('abstains without evidence when search finds nothing', async () => {
        const model = scriptedModel(searchStep('Samson pottery'), answerStep('The available information is insufficient.'));
        const app = appWith({ models: { default: model }, instance: fakeSearchInstance([]) });
        const text = await (await post(app, { query: 'Does Samson do pottery?' })).text();
        const events = sseEvents(text);
        assert.equal(
            events.some((event) => event.evidence),
            false,
        );
        assert.match(text, /insufficient/);
        assert.match(JSON.stringify(model.doStreamCalls[1].prompt), /No matching content found/);
        assert.ok(text.trimEnd().endsWith('data: [DONE]'));
    });

    await t.test('answers after the model calls the search tool, with real stage events and public evidence only', async () => {
        const instance = fakeSearchInstance([
            RESUME,
            searchChunk({ text: 'Internal note.', title: 'Private corpus label', url: '/_context/profile/' }),
            searchChunk({ text: 'Unlinked note.', title: 'Unlinked' }),
        ]);
        const model = scriptedModel(searchStep('Samson most recent role'), answerStep('Bitcomplete, ', 'until 2024.'));
        const response = await post(appWith({ models: { default: model }, instance }), {
            query: 'And then?',
            history: FIXTURES.VALID_HISTORY,
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
        assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
        const text = await response.text();
        const events = sseEvents(text);
        assert.deepEqual(
            events.filter((event) => event.progress).map((event) => event.progress),
            ['search', 'generation'],
        );
        assert.deepEqual(events.find((event) => event.evidence).evidence, [
            { title: 'Resume', url: '/resume/', text: 'Senior engineer at Bitcomplete 2020-2024.' },
        ]);
        assert.equal(
            events
                .filter((event) => event.response)
                .map((event) => event.response)
                .join(''),
            'Bitcomplete, until 2024.',
        );
        assert.equal(instance.calls.length, 1);
        assert.equal(instance.calls[0].query, 'Samson most recent role');
        assert.doesNotMatch(text, /Private corpus label|_context|Internal note/);
        const metrics = events.find((event) => event.metrics).metrics;
        assert.equal(metrics.generationUsage.prompt_tokens, 30);
        assert.ok(metrics.totalMs >= metrics.firstTokenMs);
        assert.ok(metrics.estimatedLlmCostUsd > 0);
        assert.ok(text.indexOf('"metrics"') < text.indexOf('[DONE]'));
        const prompt = model.doStreamCalls[0].prompt;
        assert.deepEqual(
            prompt.slice(1).map((message) => [message.role, message.content[0].text]),
            [...FIXTURES.VALID_HISTORY, { role: 'user', content: 'And then?' }].map(({ role, content }) => [role, content]),
        );
    });
});

test('/api/chat falls back to the next model only when the first fails before output', async (t) => {
    t.mock.method(console, 'error', () => {});
    const recovered = await post(
        appWith({
            models: {
                '@cf/zai-org/glm-4.7-flash': scriptedModel(failingStep()),
                default: scriptedModel(searchStep('role'), answerStep('Fallback answer')),
            },
        }),
    );
    const text = await recovered.text();
    assert.match(text, /Fallback answer/);
    assert.equal(sseEvents(text).find((event) => event.metrics).metrics.generationModel, '@cf/google/gemma-4-26b-a4b-it');
    assert.doesNotMatch(text, /"error"/);

    const midAnswer = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Partial' },
        ...failingStep().slice(1),
    ];
    const broken = await (
        await post(appWith({ models: { '@cf/zai-org/glm-4.7-flash': scriptedModel(midAnswer), default: scriptedModel(answerStep('Never used')) } }))
    ).text();
    assert.match(broken, /"response":"Partial"/);
    assert.match(broken, /"error":"The response could not be completed\."/);
    assert.doesNotMatch(broken, /Never used/);
});

test('/api/chat ends failures with one {error} event and [DONE], and logs them', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const everyModelFails = { default: scriptedModel(failingStep(), failingStep(), failingStep()) };
    const modelFailure = await (await post(appWith({ models: everyModelFails }))).text();
    const searchFailure = await (
        await post(
            appWith({
                models: { default: scriptedModel(searchStep('role'), answerStep('Guess')) },
                instance: fakeSearchInstance([], new Error('AI Search down')),
            }),
        )
    ).text();
    for (const text of [modelFailure, searchFailure]) {
        assert.equal(text.match(/"error":/g).length, 1);
        assert.match(text, /"error":"The response could not be completed\."/);
        assert.ok(text.trimEnd().endsWith('data: [DONE]'));
        assert.doesNotMatch(text, /"response"|AI Search down|model down/);
    }
    assert.ok(logged.mock.callCount() >= 2);
});

test('/api/chat preserves a closed connection without provider logging or SSE writes', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const refuse = createChatApp({ runTurn: () => assert.fail('must not reach the model') });
    const closed = new AbortController();
    closed.abort();
    const text = await (await post(refuse, undefined, { signal: closed.signal })).text();
    assert.equal(text, '');

    const model = scriptedModel('hang');
    const controller = new AbortController();
    // Keep the request alive: Node only weakly links a Request's signal to the controller that aborts it.
    const request = new Request(`${URLS.TEST_API_ENDPOINT}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: URLS.ALLOWED_ORIGIN },
        body: JSON.stringify({ query: 'Question?' }),
        signal: controller.signal,
    });
    const response = await appWith({ models: { default: model } }).request('/api/chat', request, ENV, { waitUntil() {} });
    const reader = response.body.getReader();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    let read = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) read += new TextDecoder().decode(chunk.value);
    assert.doesNotMatch(read, /error|DONE/);
    assert.equal(request.signal.aborted, true);
    assert.equal(logged.mock.callCount(), 0);
});

test('/api/chat treats the request deadline as a safe failure instead of an outage', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const deadline = new AbortController();
    t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
    deadline.abort(new DOMException('Timed out', 'TimeoutError'));
    const text = await (await post(appWith({ models: { default: scriptedModel('hang') } }))).text();
    assert.match(text, /"error":"The response could not be completed\."/);
    assert.ok(text.trimEnd().endsWith('data: [DONE]'));
    assert.equal(logged.mock.callCount(), 0);
});

test('/api/chat rejects invalid requests and unavailable bindings explicitly, before any model call', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const app = createChatApp({ runTurn: () => assert.fail('Generation must not start') });
    for (const { body, env, status, error, log } of [
        { body: { query: '   ' }, status: 400, error: 'Invalid query. Must be a string < 500 chars.' },
        { body: { query: 'hello' }, status: 503, error: 'Service Unavailable: AI binding missing' },
        {
            body: { query: 'What do you build?' },
            env: { AI: {} },
            status: 503,
            error: 'Retrieval service unavailable',
            log: ['AI Search Failed: AI_SEARCH binding or AI_SEARCH_INSTANCE missing'],
        },
        {
            body: { query: 'What do you build?' },
            env: { AI: {}, AI_SEARCH: {} },
            status: 503,
            error: 'Retrieval service unavailable',
            log: ['AI Search Failed: AI_SEARCH binding or AI_SEARCH_INSTANCE missing'],
        },
    ]) {
        logged.mock.resetCalls();
        const response = await post(app, body, { env: env ?? {} });
        assert.equal(response.status, status, error);
        assert.match(response.headers.get('Content-Type'), /application\/json/);
        assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', error);
        assert.deepEqual(await response.json(), { error });
        assert.deepEqual(
            logged.mock.calls.map((call) => call.arguments),
            log ? [log] : [],
        );
    }
});

test('/api/chat rejects malformed JSON with a client error', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const request = new Request(`${URLS.TEST_API_ENDPOINT}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
    });
    const response = await onRequest({ request, env: {} });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Malformed JSON in request body' });
    assert.equal(logged.mock.callCount(), 0);
});

test('/api/chat rejects an oversized body without parsing it', async () => {
    const response = await onRequest(
        createContext({ method: 'POST', url: `${URLS.TEST_API_ENDPOINT}/chat`, body: { query: 'x'.repeat(70 * 1024) } }),
    );
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'Request body too large.' });
});

test('/api/chat rejects requests over the rate limit before any work', async () => {
    const keys = [];
    const env = { CHAT_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: false }) } };
    const response = await onRequest(createContext({ method: 'POST', url: `${URLS.TEST_API_ENDPOINT}/chat`, body: { query: 'hello' }, env }));
    assert.equal(response.status, 429);
    assert.match((await response.json()).error, /Too many requests/);
    assert.deepEqual(keys, ['unknown']);
});

test('CORS preflight allows only the configured origins', async () => {
    const preflight = (origin) => onRequest(createContext({ method: 'OPTIONS', url: `${URLS.TEST_API_ENDPOINT}/chat`, origin }));
    // Hono answers 204 either way; a disallowed origin simply gets no ACAO header, so the browser blocks the real request.
    const blocked = await preflight(URLS.DISALLOWED_ORIGIN);
    assert.equal(blocked.status, 204);
    assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), null);
    const allowed = await preflight(undefined);
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), URLS.ALLOWED_ORIGIN);
    assert.match(allowed.headers.get('Access-Control-Allow-Methods'), /POST/);
    assert.equal(allowed.headers.get('Access-Control-Max-Age'), '86400');
});

test('createChatApp runs the route with an injected turn and origin list', async () => {
    const calls = [];
    const app = createChatApp({
        allowedOrigins: ['https://example.test'],
        runTurn: async function* ({ env, query, history }) {
            calls.push({ ai: env.AI, query, history });
            yield { response: 'Injected' };
        },
    });
    const init = (origin) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ query: 'Hello' }),
    });
    const allowed = await app.request('/api/chat', init('https://example.test'), ENV, { waitUntil() {} });
    const text = await allowed.text();
    assert.deepEqual(sseEvents(text), [{ response: 'Injected' }]);
    assert.ok(text.trimEnd().endsWith('data: [DONE]'));
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://example.test');
    assert.deepEqual(calls, [{ ai: ENV.AI, query: 'Hello', history: [] }]);
    const blocked = await app.request('/api/chat', init('https://samsongama.com'), ENV, { waitUntil() {} });
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);
});
