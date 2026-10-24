import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiService } from '../../functions/_lib/ai.js';
import { memoryStore, retrievalCacheKey, workersCacheStore } from '../../functions/_lib/retrieval-cache.js';
import { buildEmbeddingsResponse, buildVectorizeResult } from '../helpers/data.mjs';
import { makeEnv } from '../helpers/mocks.mjs';

const CONTEXT = 'Samson operates Kubernetes clusters for production training and inference workloads.';

test('retrieval cache keys separate corpus namespaces and queries', async () => {
    const key = await retrievalCacheKey('corpus-a', 'What is deployed?');
    assert.equal(key, await retrievalCacheKey('corpus-a', 'What is deployed?'));
    assert.notEqual(key, await retrievalCacheKey('corpus-b', 'What is deployed?'));
    assert.notEqual(key, await retrievalCacheKey('corpus-a', 'What is hosted?'));
});

test('memory store returns independent copies and misses unknown keys', async () => {
    const store = memoryStore();
    const payload = { contextText: CONTEXT, evidence: [{ url: '/portfolio/k8s/', text: CONTEXT }] };
    await store.put('ns', 'q', payload);
    payload.contextText = 'mutated by caller';
    const hit = await store.get('ns', 'q');
    assert.equal(hit.contextText, CONTEXT);
    hit.evidence.push({});
    assert.equal((await store.get('ns', 'q')).evidence.length, 1);
    assert.equal(await store.get('ns', 'other'), null);
});

test('workers store treats a failing cache as a miss and never rejects', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const failing = {
        match: async () => {
            throw new Error('cache unavailable');
        },
        put: async () => {
            throw new Error('cache unavailable');
        },
    };
    const store = workersCacheStore(failing);
    assert.equal(await store.get('ns', 'q'), null);
    await store.put('ns', 'q', { contextText: CONTEXT, evidence: [] });
    assert.equal(logged.mock.callCount(), 2);
});

test('a repeat query is served from the store without embedding or Vectorize calls', async () => {
    let embeddings = 0;
    let searches = 0;
    const env = makeEnv({
        aiRun: async () => {
            embeddings++;
            return buildEmbeddingsResponse([0.1, 0.2]);
        },
        vectorizeQuery: async () => {
            searches++;
            return buildVectorizeResult([{ text: CONTEXT }]);
        },
    });
    const store = memoryStore();

    const first = await new AiService(env, { retrievalStore: store }).retrieveContext('Kubernetes?');
    const second = await new AiService(env, { retrievalStore: store }).retrieveContext('Kubernetes?');

    assert.equal(first, CONTEXT);
    assert.equal(second, CONTEXT);
    assert.equal(embeddings, 1);
    assert.equal(searches, 1);
});

test('empty retrieval results are never cached', async () => {
    let searches = 0;
    const env = makeEnv({
        aiRun: async () => buildEmbeddingsResponse([0.1, 0.2]),
        vectorizeQuery: async () => {
            searches++;
            return buildVectorizeResult([]);
        },
    });
    const store = memoryStore();

    await new AiService(env, { retrievalStore: store }).retrieveContext('Unknown topic?');
    await new AiService(env, { retrievalStore: store }).retrieveContext('Unknown topic?');

    assert.equal(searches, 2);
});

test('no store configured means every query runs the full retrieval path', async () => {
    let searches = 0;
    const env = makeEnv({
        aiRun: async () => buildEmbeddingsResponse([0.1, 0.2]),
        vectorizeQuery: async () => {
            searches++;
            return buildVectorizeResult([{ text: CONTEXT }]);
        },
    });

    await new AiService(env).retrieveContext('Kubernetes?');
    await new AiService(env).retrieveContext('Kubernetes?');

    assert.equal(searches, 2);
});

test('memory store evicts the oldest entry once it reaches its bound', async () => {
    const store = memoryStore({ maxEntries: 2 });
    await store.put('ns', 'first', { contextText: CONTEXT, evidence: [] });
    await store.put('ns', 'second', { contextText: CONTEXT, evidence: [] });
    await store.put('ns', 'third', { contextText: CONTEXT, evidence: [] });
    assert.equal(store.size, 2);
    assert.equal(await store.get('ns', 'first'), null);
    assert.notEqual(await store.get('ns', 'third'), null);
});
