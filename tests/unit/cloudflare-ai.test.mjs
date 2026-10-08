import { makeProviderStream } from '../helpers/mocks.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudflareAi } from '../../scripts/lib/cloudflare-ai.mjs';
import { AI_CONFIG, corpusRecordId } from '../../functions/_lib/application.js';

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
            return new Response(makeProviderStream('Answer'), {
                headers: { 'Content-Type': 'text/event-stream' },
            });
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
        ...options,
        fetchImpl: async () => new Response('failure', { status: 429 }),
    });
    await assert.rejects(failed.run('@cf/test/model', {}), /HTTP 429/);
    const invalid = createCloudflareAi({
        ...options,
        fetchImpl: async () => Response.json({ result: { response: 'not SSE' } }),
    });
    await assert.rejects(invalid.run('@cf/test/model', {}), /did not return SSE/);
});

test('invalid embeddings and upstream failures stop retrieval without search or retries', async () => {
    for (const response of [Response.json({ success: true, result: { data: [[0.1]] } }), Response.json({ success: false }, { status: 504 })]) {
        let calls = 0;
        const client = createCloudflareAi({
            ...options,
            fetchImpl: async () => {
                calls++;
                return response;
            },
        });
        await assert.rejects(client.retrieve('question'), /Invalid embedding vector|504/);
        assert.equal(calls, 1);
    }
});

test('malformed search responses fail explicitly', async () => {
    let calls = 0;
    const client = createCloudflareAi({
        ...options,
        fetchImpl: async () => {
            calls++;
            return Response.json({
                success: true,
                result: calls === 1 ? { data: [Array(AI_CONFIG.embedding.dimensions).fill(0.1)] } : { matches: null },
            });
        },
    });
    await assert.rejects(client.retrieve('question'), /Invalid retrieval result/);
    assert.equal(calls, 2);
});

test('retrieval uses injected fetch for SDK embeddings and Vectorize query', async () => {
    const requests = [];
    const vector = Array(AI_CONFIG.embedding.dimensions).fill(0.1);
    const matches = [{ id: 'source', score: 0.9, metadata: { recordType: 'chunk', text: 'Evidence' } }];
    const client = createCloudflareAi({
        ...options,
        async fetchImpl(url, init) {
            const request = new Request(url, init);
            const pathname = new URL(request.url).pathname;
            const body = await request.json();
            assert.equal(request.method, 'POST');
            assert.equal(request.headers.get('content-type'), 'application/json');
            requests.push(pathname);
            const base = '/client/v4/accounts/test-account';
            if (requests.length === 1) {
                assert.equal(pathname, `${base}/ai/run/${AI_CONFIG.embedding.model}`);
                assert.deepEqual(body, { text: ['question'] });
                return Response.json({ success: true, result: { data: [vector] } });
            }
            assert.equal(requests.length, 2);
            assert.equal(pathname, `${base}/vectorize/v2/indexes/portfolio-index/query`);
            assert.deepEqual(body, {
                vector,
                namespace: options.namespace,
                topK: AI_CONFIG.retrieval.topK,
                returnMetadata: 'all',
            });
            return Response.json({ success: true, result: { matches } });
        },
    });
    const result = await client.retrieve('question');
    assert.deepEqual(result.matches, matches);
    assert.equal(requests.length, 2);
    assert.ok(result.embeddingMs >= 0 && result.searchMs >= 0);
});

test('retrieval contextualizes follow-ups before generating embeddings', async () => {
    const requests = [];
    const vector = Array(AI_CONFIG.embedding.dimensions).fill(0.1);
    const client = createCloudflareAi({
        ...options,
        async fetchImpl(url, init) {
            const request = new Request(url, init);
            const pathname = new URL(request.url).pathname;
            const body = await request.json();
            requests.push({ pathname, body });
            const base = '/client/v4/accounts/test-account';
            if (body.stream === false) {
                return Response.json({ success: true, result: { response: 'What is Samson Gama’s most recent role?' } });
            }
            if (pathname === `${base}/ai/run/${AI_CONFIG.embedding.model}`) {
                assert.deepEqual(body.text, ['What is Samson Gama’s most recent role?']);
                return Response.json({ success: true, result: { data: [vector] } });
            }
            assert.ok(pathname.endsWith('/vectorize/v2/indexes/portfolio-index/query'));
            return Response.json({ success: true, result: { matches: [] } });
        },
    });

    const result = await client.retrieve('Most recently?', [{ role: 'user', content: 'What did he do last?' }]);

    assert.deepEqual(result.matches, []);
    assert.equal(result.retrievalQuery, 'What is Samson Gama’s most recent role?');
    assert.equal(requests.length, 3);
    assert.equal(requests[0].body.stream, false);
    assert.equal(requests[0].body.max_completion_tokens, AI_CONFIG.contextualization.maxCompletionTokens);
});

test('cloud retrieval expands a semantic hit using its namespace-specific parent section', async () => {
    const source = 'content/posts/project/index.md';
    const id = await corpusRecordId(options.namespace, source, -1);
    const section = {
        id,
        metadata: { source, recordType: 'section', sectionIndex: -1, text: 'Hugo deployment and Cloudflare rollback', url: '/posts/project' },
    };
    const calls = [];
    const client = createCloudflareAi({
        ...options,
        async fetchImpl(url, init) {
            const request = new Request(url, init);
            const pathname = new URL(request.url).pathname;
            const body = await request.json();
            calls.push(pathname);
            if (pathname.includes('/ai/run/')) {
                return Response.json({ success: true, result: { data: [Array(AI_CONFIG.embedding.dimensions).fill(0.1)] } });
            }
            if (pathname.endsWith('/get_by_ids')) {
                assert.deepEqual(body.ids, [id]);
                return Response.json({ success: true, result: [section] });
            }
            assert.ok(pathname.endsWith('/query'));
            return Response.json({
                success: true,
                result: {
                    matches: [{ id: 'child', score: 0.9, metadata: { recordType: 'chunk', source, parentIndex: -1, text: 'Hugo deployment' } }],
                },
            });
        },
    });

    test('cloud retrieval fails when a matched parent cannot be fetched', async () => {
        const client = createCloudflareAi({
            ...options,
            async fetchImpl(url, init) {
                const request = new Request(url, init);
                const pathname = new URL(request.url).pathname;
                if (pathname.includes('/ai/run/')) {
                    return Response.json({ success: true, result: { data: [Array(AI_CONFIG.embedding.dimensions).fill(0.1)] } });
                }
                if (pathname.endsWith('/get_by_ids')) return Response.json({ success: true, result: [] });
                return Response.json({
                    success: true,
                    result: { matches: [{ metadata: { recordType: 'chunk', source: 'content/project.md', parentIndex: -1, text: 'Partial' } }] },
                });
            },
        });
        await assert.rejects(client.retrieve('question'), /Missing or invalid parent/);
    });
    const result = await client.retrieve('How is the project deployed?');
    assert.equal(result.matches[0].id, id);
    assert.equal(result.matches[0].score, 0.9);
    assert.match(result.matches[0].metadata.text, /rollback/);
    assert.equal(calls.length, 3);
});
