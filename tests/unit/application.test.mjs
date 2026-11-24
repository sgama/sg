import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_CONFIG, AI_MODELS, estimateCost, getModel } from '../../shared/ai/application.js';
import { AppError, requireSearchBinding } from '../../functions/_lib/worker-errors.js';

test('AppError defaults to 500 and keeps an explicit status and name', () => {
    const fallback = new AppError('Something failed');
    assert.ok(fallback instanceof Error);
    assert.equal(fallback.name, 'AppError');
    assert.equal(fallback.message, 'Something failed');
    assert.equal(fallback.status, 500);
    assert.equal(new AppError('Retrieval service unavailable', 503).status, 503);
});

test('config exposes the search and generation contract and a usable model registry', () => {
    assert.deepEqual(Object.keys(AI_CONFIG.search).sort(), [
        'chunkOverlap',
        'chunkSize',
        'contextExpansion',
        'instancePrefix',
        'matchThreshold',
        'maxContextChars',
        'maxResults',
        'reranker',
    ]);
    assert.equal('retrieval' in AI_CONFIG || 'contextualization' in AI_CONFIG, false);
    for (const name of [AI_CONFIG.generation.defaultModel, ...AI_CONFIG.generation.fallbackModels]) assert.ok(AI_MODELS[name], name);
    assert.ok(AI_CONFIG.generation.maxSteps >= 2);
});

test('estimateCost returns null for zero-valued usage only when a rate is missing', () => {
    const model = getModel('glm');
    assert.equal(estimateCost({ prompt_tokens: 0, completion_tokens: 0 }, model), 0);
    assert.equal(estimateCost({ prompt_tokens: 1, completion_tokens: 1 }, { ...model, inputPerMillion: undefined }), null);
    assert.equal(estimateCost({ prompt_tokens: 1, completion_tokens: 1 }, { ...model, outputPerMillion: null }), null);
});

test('estimateCost uses each model published input and output rate per million tokens', () => {
    for (const [name, model] of Object.entries(AI_MODELS)) {
        const usage = { prompt_tokens: 1000, completion_tokens: 500 };
        assert.equal(estimateCost(usage, model), (1000 * model.inputPerMillion + 500 * model.outputPerMillion) / 1e6, name);
    }
});

test('getModel resolves names and ids, defaults to the configured model, and rejects unknown ids', () => {
    assert.equal(getModel(), AI_MODELS[AI_CONFIG.generation.defaultModel]);
    assert.equal(getModel('glm'), AI_MODELS.glm);
    assert.equal(getModel('@cf/zai-org/glm-4.7-flash'), AI_MODELS.glm);
    assert.equal(getModel('llama').id, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    assert.throws(() => getModel('typo'), /Unknown AI model: typo\. Choose glm, gemma, llama/);
});

test('requireSearchBinding needs both the binding and the live instance name, and logs once when missing', (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    assert.equal(requireSearchBinding({ AI_SEARCH: {}, AI_SEARCH_INSTANCE: 'portfolio-abc' }), undefined);
    assert.equal(logged.mock.callCount(), 0);
    for (const env of [undefined, {}, { AI_SEARCH: {} }, { AI_SEARCH_INSTANCE: 'portfolio-abc' }]) {
        assert.throws(
            () => requireSearchBinding(env),
            (error) => error instanceof AppError && error.status === 503 && error.message === 'Retrieval service unavailable',
        );
    }
    assert.equal(logged.mock.callCount(), 4);
});
