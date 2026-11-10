import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    AI_CONFIG,
    AI_MODELS,
    AppError,
    contextualizationInput,
    contextualizedQueryFromResponse,
    estimateCost,
    generationInput,
    getModel,
    requireVectorizeBinding,
    rewriteSearchQuery,
} from '../../functions/_lib/application.js';

test('AppError defaults to 500 and keeps an explicit status and name', () => {
    const fallback = new AppError('Something failed');
    assert.ok(fallback instanceof Error);
    assert.equal(fallback.name, 'AppError');
    assert.equal(fallback.message, 'Something failed');
    assert.equal(fallback.status, 500);
    assert.equal(new AppError('Retrieval service unavailable', 503).status, 503);
});

test('contextualizationInput sends the model-specific token limit and contextualization messages', () => {
    const query = 'And then?';
    const history = [{ role: 'user', content: 'What did he do last?' }];
    for (const name of ['glm', 'gemma', 'llama']) {
        const model = getModel(name);
        const input = contextualizationInput(model, query, history);
        assert.equal(input.stream, false, name);
        assert.equal(input[model.completionLimitKey], AI_CONFIG.contextualization.maxCompletionTokens, name);
        assert.equal(input.messages[0].role, 'system', name);
        assert.deepEqual(JSON.parse(input.messages[1].content), { history, query }, name);
        assert.equal(input.chat_template_kwargs?.enable_thinking, name === 'llama' ? undefined : false, name);
    }
    assert.deepEqual(JSON.parse(contextualizationInput(getModel('llama'), query).messages[1].content), { history: [], query });
});

test('contextualizedQueryFromResponse accepts known response shapes at the size boundary and trims them', () => {
    const max = AI_CONFIG.contextualization.maxQueryChars;
    assert.equal(contextualizedQueryFromResponse('  Samson latest role?  '), 'Samson latest role?');
    assert.equal(contextualizedQueryFromResponse({ response: '  Samson latest role?  ' }), 'Samson latest role?');
    assert.equal(contextualizedQueryFromResponse({ choices: [{ message: { content: '  Samson latest role?  ' } }] }), 'Samson latest role?');
    assert.equal(contextualizedQueryFromResponse('x'.repeat(max)), 'x'.repeat(max));
});

test('contextualizedQueryFromResponse rejects empty, oversized, multi-line and unknown output', () => {
    const max = AI_CONFIG.contextualization.maxQueryChars;
    for (const response of ['', '   ', 'x'.repeat(max + 1), 'query\nexplanation', 'query\rexplanation', { response: '' }]) {
        assert.throws(() => contextualizedQueryFromResponse(response), /Invalid contextualized query/);
    }
    assert.throws(() => contextualizedQueryFromResponse({}), /Invalid contextualization response/);
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

test('generationInput sends the model-specific token limit, messages and parameters', () => {
    const messages = [{ role: 'user', content: 'What do you build?' }];
    for (const name of ['glm', 'gemma']) {
        const input = generationInput(getModel(name), messages);
        assert.equal(input.messages, messages, name);
        assert.equal(input.stream, true, name);
        assert.equal(input.max_completion_tokens, AI_CONFIG.generation.maxCompletionTokens, name);
        assert.equal(input.max_tokens, undefined, name);
        assert.deepEqual(input.chat_template_kwargs, { enable_thinking: false }, name);
    }
    const llama = generationInput(getModel('llama'), messages);
    assert.equal(llama.max_tokens, AI_CONFIG.generation.maxCompletionTokens);
    assert.equal(llama.max_completion_tokens, undefined);
    assert.equal(llama.chat_template_kwargs, undefined);
});

test('getModel resolves names and ids, defaults to the configured model, and rejects unknown ids', () => {
    assert.equal(getModel(), AI_MODELS[AI_CONFIG.generation.defaultModel]);
    assert.equal(getModel('glm'), AI_MODELS.glm);
    assert.equal(getModel('@cf/zai-org/glm-4.7-flash'), AI_MODELS.glm);
    assert.equal(getModel('llama').id, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    assert.throws(() => getModel('typo'), /Unknown AI model: typo\. Choose glm, gemma, llama/);
});

test('requireVectorizeBinding passes a binding through and throws the documented 503 without one', (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    assert.equal(requireVectorizeBinding({}), undefined);
    assert.equal(logged.mock.callCount(), 0);
    assert.throws(
        () => requireVectorizeBinding(undefined),
        (error) => error instanceof AppError && error.status === 503 && error.message === 'Retrieval service unavailable',
    );
    assert.deepEqual(
        logged.mock.calls.map((call) => call.arguments),
        [['Vector Search Failed: VECTORIZE_INDEX binding missing']],
    );
});

test('rewriteSearchQuery forwards the contextualization input and returns the rewritten query', async () => {
    const model = getModel(AI_CONFIG.contextualization.model);
    const history = [{ role: 'user', content: 'What did he do last?' }];
    let call;
    const query = await rewriteSearchQuery('And then?', history, model, async (...args) => {
        call = args;
        return { response: '  What is Samson Gama’s most recent role?  ' };
    });
    assert.equal(query, 'What is Samson Gama’s most recent role?');
    assert.equal(call[0], model.id);
    assert.equal(call[1].stream, false);
    assert.equal(call[1][model.completionLimitKey], AI_CONFIG.contextualization.maxCompletionTokens);
    assert.deepEqual(JSON.parse(call[1].messages[1].content), { history, query: 'And then?' });
});

test('rewriteSearchQuery propagates a contextualization AppError and rejects malformed output', async () => {
    const model = getModel(AI_CONFIG.contextualization.model);
    const failure = new AppError('Query contextualization service unavailable', 503);
    await assert.rejects(
        rewriteSearchQuery('And then?', [], model, async () => {
            throw failure;
        }),
        (error) => error === failure,
    );
    // A malformed provider response is a plain Error; only the service wraps transport failures in AppError.
    await assert.rejects(
        rewriteSearchQuery('And then?', [], model, async () => ({ response: '' })),
        /Invalid contextualized query/,
    );
});
