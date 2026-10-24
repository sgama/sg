import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiService } from '../../functions/_lib/ai.js';
import { retrievalCacheKey, workersCacheStore } from '../../functions/_lib/retrieval-cache.js';
import { buildEmbeddingsResponse, buildVectorizeResult } from '../helpers/data.mjs';
import { makeEnv, makeRetrievalStore } from '../helpers/mocks.mjs';

const CONTEXT = 'Samson operates Kubernetes clusters for production training and inference workloads.';

test('retrieval cache keys separate corpus namespaces and queries', async () => {
    const key = await retrievalCacheKey('corpus-a', 'What is deployed?');
    assert.equal(key, await retrievalCacheKey('corpus-a', 'What is deployed?'));
    assert.notEqual(key, await retrievalCacheKey('corpus-b', 'What is deployed?'));
    assert.notEqual(key, await retrievalCacheKey('corpus-a', 'What is hosted?'));
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
    const store = makeRetrievalStore();

    const first = (await new AiService(env, { retrievalStore: store }).retrieve('Kubernetes?')).contextText;
    const second = (await new AiService(env, { retrievalStore: store }).retrieve('Kubernetes?')).contextText;

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
    const store = makeRetrievalStore();

    (await new AiService(env, { retrievalStore: store }).retrieve('Unknown topic?')).contextText;
    (await new AiService(env, { retrievalStore: store }).retrieve('Unknown topic?')).contextText;

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

    (await new AiService(env).retrieve('Kubernetes?')).contextText;
    (await new AiService(env).retrieve('Kubernetes?')).contextText;

    assert.equal(searches, 2);
});
