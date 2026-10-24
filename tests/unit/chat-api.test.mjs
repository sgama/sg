/**
 * Unit tests for /api/chat endpoint
 * Tests CORS handling, input validation, guardrails, and end-to-end chat flow
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../helpers/worker.mjs';
import { createChatApp } from '../../functions/_lib/chat-app.js';
import { buildEmbeddingsResponse, buildVectorizeResult, URLS, SAMPLE_DATA, FIXTURES } from '../helpers/data.mjs';
import { createContext, makeStream, makeProviderStream } from '../helpers/mocks.mjs';

test('/api/chat', async (t) => {
    await t.test('streams real stage events and only public excerpts actually supplied to generation', async () => {
        const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
        const response = await onRequest(
            createContext({
                method: 'POST',
                url: `${URLS.TEST_API_ENDPOINT}/chat`,
                body: { query: 'And then?', history: [{ role: 'user', content: 'Earlier?' }] },
                env: {
                    AI: {
                        async run(_model, payload) {
                            if (payload.stream === false) return { response: 'Standalone query' };
                            if (payload.text) return buildEmbeddingsResponse([0.1]);
                            assert.ok(payload.messages[0].content.includes('Public evidence'));
                            return makeProviderStream('Answer', usage);
                        },
                    },
                    VECTORIZE_INDEX: {
                        query: async () => ({
                            matches: [
                                {
                                    metadata: {
                                        recordType: 'chunk',
                                        title: 'Resume',
                                        url: '/resume/',
                                        section: 'Experience',
                                        text: 'Public evidence',
                                    },
                                },
                                {
                                    metadata: {
                                        recordType: 'chunk',
                                        title: 'Private corpus label',
                                        source: 'content/_context/profile.md',
                                        text: 'Internal evidence',
                                    },
                                },
                            ],
                        }),
                    },
                },
            }),
        );
        const text = await response.text();
        const events = text
            .split('\n')
            .filter((line) => line.startsWith('data: {'))
            .map((line) => JSON.parse(line.slice(6)));
        assert.deepEqual(
            events.filter((event) => event.progress).map((event) => event.progress),
            ['rewrite', 'embedding', 'search', 'generation'],
        );
        const evidence = events.find((event) => event.evidence).evidence;
        assert.deepEqual(evidence, [{ title: 'Resume', url: '/resume/', section: 'Experience', text: 'Public evidence' }]);
        assert.doesNotMatch(text, /content\/|Internal evidence|Private corpus label/);
    });

    await t.test('retrieval failures after streaming starts emit explicit errors, not successful abstention', async (t) => {
        t.mock.method(console, 'error', () => {});
        const response = await onRequest(
            createContext({
                method: 'POST',
                url: `${URLS.TEST_API_ENDPOINT}/chat`,
                body: { query: 'Question?' },
                env: {
                    AI: {
                        run: async () => {
                            throw new Error('Provider failed');
                        },
                    },
                    VECTORIZE_INDEX: { query: async () => assert.fail('Search must not run') },
                },
            }),
        );
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.match(text, /"progress":"embedding"/);
        assert.match(text, /"error":"Embedding service unavailable"/);
        assert.doesNotMatch(text, /"response":/);
    });

    await t.test('End-to-end flow', async (t) => {
        await t.test('normalizes GLM output before streaming to the widget and saving to KV', async () => {
            const saved = [];
            const pending = [];
            const usage = { prompt_tokens: 1195, completion_tokens: 787, total_tokens: 1982 };
            const env = {
                AI: {
                    async run(model, payload) {
                        if (payload.text) return buildEmbeddingsResponse([0.1]);
                        assert.equal(payload.chat_template_kwargs.enable_thinking, false);
                        return makeStream(
                            'data: {"choices":[{"index":0,"delta":{"reasoning_content":"private"}}]}\n',
                            'data: {"choices":[{"index":0,"delta":{"content":"Visible answer"}}]}\n',
                            `data: ${JSON.stringify({ choices: [], usage })}\n`,
                            'data: [DONE]\n',
                        );
                    },
                },
                VECTORIZE_INDEX: {
                    async query() {
                        return buildVectorizeResult(['Relevant portfolio context for response.']);
                    },
                },
                CHAT_LOGS: {
                    async put(_key, value) {
                        saved.push(JSON.parse(value));
                    },
                },
            };
            const response = await onRequest(
                createContext({
                    method: 'POST',
                    url: `${URLS.TEST_API_ENDPOINT}/chat`,
                    body: { query: 'What do you build?' },
                    env,
                    waitUntil(promise) {
                        pending.push(promise);
                    },
                }),
            );
            const output = await response.text();
            await Promise.all(pending);
            assert.equal(response.status, 200);
            assert.match(output, /"response":"Visible answer"/);
            assert.doesNotMatch(output, /private|reasoning|choices/);
            assert.equal(saved.length, 1);
            assert.equal(saved[0].response, 'Visible answer');
            assert.deepEqual(saved[0].usage, usage);
            const metrics = output
                .split('\n')
                .filter((line) => line.startsWith('data: {'))
                .map((line) => JSON.parse(line.slice(6)))
                .find((event) => event.metrics)?.metrics;
            assert.deepEqual(metrics.generationUsage, usage);
            assert.ok(metrics.totalMs >= metrics.firstTokenMs);
            assert.ok(metrics.estimatedLlmCostUsd > 0);
        });

        await t.test('passes trimmed query and sanitized history into generation', async () => {
            const calls = [];
            const env = {
                AI: {
                    async run(model, payload) {
                        calls.push({ model, payload });
                        if (payload?.stream === false) {
                            return { response: 'What is Samson’s most recent role?' };
                        }
                        if (payload?.text) {
                            return buildEmbeddingsResponse([0.1, 0.2, 0.3]);
                        }
                        return makeProviderStream('Supported answer');
                    },
                },
                VECTORIZE_INDEX: {
                    async query() {
                        return buildVectorizeResult([SAMPLE_DATA.CONTEXT_TEXT]);
                    },
                },
            };

            const response = await onRequest(
                createContext({
                    method: 'POST',
                    url: `${URLS.TEST_API_ENDPOINT}/chat`,
                    env,
                    body: {
                        query: '  What do you build?  ',
                        history: FIXTURES.VALID_HISTORY,
                    },
                }),
            );

            assert.equal(response.status, 200);
            assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
            assert.equal(response.headers.get('Cache-Control'), 'no-cache');
            assert.match(await response.text(), /"response":"Supported answer"/);

            assert.equal(calls.length, 3);
            assert.equal(calls[0].payload.stream, false);
            assert.deepEqual(calls[1].payload.text, ['What is Samson’s most recent role?']);
            assert.equal(calls[2].payload.messages.at(-1).content, 'What do you build?');
            assert.deepEqual(calls[2].payload.messages.slice(1, -1), FIXTURES.VALID_HISTORY);
        });
    });

    await t.test('Guardrails', async (t) => {
        await t.test('returns grounded fallback when retrieval has no context', async () => {
            const calls = [];
            const env = {
                AI: {
                    async run(model, payload) {
                        calls.push({ model, payload });
                        if (payload?.text) {
                            return buildEmbeddingsResponse([0.1, 0.2, 0.3]);
                        }
                        return makeProviderStream('Should not generate');
                    },
                },
                VECTORIZE_INDEX: {
                    async query() {
                        return buildVectorizeResult([]);
                    },
                },
            };

            const response = await onRequest(
                createContext({
                    method: 'POST',
                    url: `${URLS.TEST_API_ENDPOINT}/chat`,
                    env,
                    body: { query: 'Tell me unknown details' },
                }),
            );

            const body = await response.text();
            assert.equal(response.status, 200);
            assert.match(body, /don't have enough reliable context/i);

            // Only embeddings should run; generation should be skipped due to abstain guardrail.
            assert.equal(calls.length, 1);
        });
    });
});

test('/api/chat rejects invalid requests and unavailable bindings explicitly, before any generation', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const refuseAi = { AI: { run: async () => assert.fail('Generation must not start') } };
    for (const { body, env, status, error, log } of [
        { body: { query: SAMPLE_DATA.INJECTION_QUERY }, status: 400, error: 'Query rejected by guardrails.' },
        { body: { query: '   ' }, status: 400, error: 'Invalid query. Must be a string < 500 chars.' },
        { body: { query: 'hello' }, status: 503, error: 'Service Unavailable: AI binding missing' },
        {
            body: { query: 'What do you build?' },
            env: refuseAi,
            status: 503,
            error: 'Retrieval service unavailable',
            log: ['Vector Search Failed: VECTORIZE_INDEX binding missing'],
        },
    ]) {
        logged.mock.resetCalls();
        const response = await onRequest(createContext({ method: 'POST', url: `${URLS.TEST_API_ENDPOINT}/chat`, body, env }));
        assert.equal(response.status, status, error);
        assert.match(response.headers.get('Content-Type'), /application\/json/);
        assert.deepEqual(await response.json(), { error });
        assert.deepEqual(
            logged.mock.calls.map((call) => call.arguments),
            log ? [log] : [],
        );
    }
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

test('createChatApp runs the route with injected collaborators and origin list', async () => {
    const calls = [];
    const app = createChatApp({
        allowedOrigins: ['https://example.test'],
        createAiService: (env) => ({ fromEnv: env.AI }),
        answerChat: async ({ aiService, query }) => {
            calls.push({ aiService, query });
            return makeStream('data: {"response":"Injected"}', 'data: [DONE]');
        },
    });
    const env = { AI: 'ai-binding', VECTORIZE_INDEX: {} };
    const init = (origin) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ query: 'Hello' }),
    });
    const allowed = await app.request('/api/chat', init('https://example.test'), env, { waitUntil() {} });
    assert.match(await allowed.text(), /Injected/);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://example.test');
    assert.deepEqual(calls, [{ aiService: { fromEnv: 'ai-binding' }, query: 'Hello' }]);
    const blocked = await app.request('/api/chat', init('https://samsongama.com'), env, { waitUntil() {} });
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);
});
