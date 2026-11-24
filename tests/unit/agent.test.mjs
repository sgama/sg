import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelChain, runTurn, runWithFallback, searchPortfolioTool } from '../../functions/_lib/agent.js';
import { AI_CONFIG, getModel } from '../../shared/ai/application.js';
import { SYSTEM_PROMPT } from '../../shared/ai/prompts.js';
import { answerStep, failingStep, fakeSearchInstance, scriptedModel, searchChunk, searchStep } from '../helpers/mocks.mjs';

const ENV = { AI: {} };
const collect = async (iterable) => {
    const items = [];
    for await (const item of iterable) items.push(item);
    return items;
};
const models = ['glm', 'gemma', 'llama'].map((name) => getModel(name));

test('modelChain starts with the configured model, then the fallbacks, without duplicates', () => {
    assert.deepEqual(
        modelChain(undefined).map((model) => model.id),
        [AI_CONFIG.generation.defaultModel, ...AI_CONFIG.generation.fallbackModels].map((name) => getModel(name).id),
    );
    assert.deepEqual(
        modelChain('llama').map((model) => model.id),
        ['llama', 'gemma'].map((name) => getModel(name).id),
    );
    assert.throws(() => modelChain('typo'), /Unknown AI model/);
});

test('runTurn sends the short system prompt, history and query, and caps output and steps', async () => {
    const model = scriptedModel(answerStep('Hello!'));
    const history = [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
    ];
    const events = await collect(runTurn({ env: ENV, query: 'Thanks', history, languageModel: () => model, instance: fakeSearchInstance() }));
    assert.deepEqual(events[0], { progress: 'generation' });
    const [call] = model.doStreamCalls;
    assert.equal(call.prompt[0].content, SYSTEM_PROMPT);
    assert.ok(SYSTEM_PROMPT.split('\n').length <= 10);
    assert.deepEqual(
        call.prompt.slice(1).map((message) => message.content[0].text),
        ['Hi', 'Hello', 'Thanks'],
    );
    assert.equal(call.maxOutputTokens, AI_CONFIG.generation.maxCompletionTokens);
    assert.deepEqual(
        call.tools.map((tool) => tool.name),
        ['searchPortfolio'],
    );
});

test('runTurn forces an answer on the last allowed step', async () => {
    const model = scriptedModel(searchStep('a'), searchStep('b'), answerStep('Final'));
    const instance = fakeSearchInstance([searchChunk({ text: 'Fact', title: 'T' })]);
    const events = await collect(runTurn({ env: ENV, query: 'q', history: [], languageModel: () => model, instance }));
    assert.equal(instance.calls.length, 2);
    assert.equal(model.doStreamCalls[2].toolChoice?.type, 'none');
    assert.ok(events.some((event) => event.response === 'Final'));
});

test('runWithFallback does not retry once output began, on the last model, or after an abort', async (t) => {
    t.mock.method(console, 'error', () => {});
    const attempts = [];
    const attempt = (script) => (model) => {
        attempts.push(model.id);
        return (async function* () {
            yield* script[model.id] ?? [];
        })();
    };
    const error = new Error('late');
    const parts = await collect(
        runWithFallback(
            models,
            attempt({
                [models[0].id]: [
                    { type: 'text-delta', text: 'x' },
                    { type: 'error', error },
                ],
            }),
        ),
    );
    assert.deepEqual(
        parts.map((part) => part.type),
        ['model', 'text-delta', 'error'],
    );
    assert.deepEqual(attempts.slice(-1), [models[0].id]);

    attempts.length = 0;
    const failure = new Error('all down');
    const down = Object.fromEntries(models.map((model) => [model.id, [{ type: 'error', error: failure }]]));
    await assert.rejects(collect(runWithFallback(models, attempt(down))), (thrown) => thrown === failure);
    assert.deepEqual(
        attempts,
        models.map((model) => model.id),
    );

    attempts.length = 0;
    const aborted = AbortSignal.abort(new Error('closed'));
    await assert.rejects(collect(runWithFallback(models, attempt(down), aborted)), /closed/);
    assert.deepEqual(attempts, [models[0].id]);
});

test('runWithFallback moves to the next model when a failure comes before any output', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const attempt = (model) =>
        (async function* () {
            if (model.id === models[0].id) throw new Error('thrown before output');
            if (model.id === models[1].id) return yield { type: 'error', error: new Error('error part before output') };
            yield { type: 'text-delta', text: 'ok' };
        })();
    const parts = await collect(runWithFallback(models, attempt));
    assert.deepEqual(
        parts.map((part) => part.model?.id ?? part.type),
        [models[0].id, models[1].id, models[2].id, 'text-delta'],
    );
    assert.equal(logged.mock.callCount(), 2);
});

test('runWithFallback ends when the signal aborts even if the stream goes silent', async () => {
    const silent = () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: async () => ({ done: true }) }) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('deadline')), 5);
    await assert.rejects(collect(runWithFallback(models, silent, controller.signal)), /deadline/);
});

test('searchPortfolioTool queries AI Search with the configured options and hides sources from the model', async () => {
    const instance = fakeSearchInstance([
        searchChunk({ text: 'Led the platform team.', title: 'Resume', url: '/resume/' }),
        searchChunk({ text: 'Internal.', title: 'Profile', url: '/_context/profile/' }),
    ]);
    const tool = searchPortfolioTool(instance);
    const output = await tool.execute({ query: 'platform team' }, { toolCallId: 'c', messages: [] });
    const { search } = AI_CONFIG;
    assert.deepEqual(instance.calls, [
        {
            query: 'platform team',
            ai_search_options: {
                retrieval: {
                    retrieval_type: 'hybrid',
                    max_num_results: search.maxResults,
                    match_threshold: search.matchThreshold,
                    context_expansion: search.contextExpansion,
                },
                reranking: { enabled: true, model: search.reranker },
                cache: { enabled: true },
            },
        },
    ]);
    assert.deepEqual(output.evidence, [{ title: 'Resume', url: '/resume/', text: 'Led the platform team.' }]);
    const seen = await tool.toModelOutput({ toolCallId: 'c', input: {}, output });
    assert.deepEqual(seen, { type: 'json', value: output.results });
    assert.doesNotMatch(JSON.stringify(seen), /resume\/|_context/);
    const none = await tool.toModelOutput({ toolCallId: 'c', input: {}, output: { results: [], evidence: [] } });
    assert.deepEqual(none, { type: 'json', value: { results: [], message: 'No matching content found.' } });
});

test('searchPortfolioTool rejects empty and oversized queries', async () => {
    const tool = searchPortfolioTool(fakeSearchInstance());
    assert.equal(tool.inputSchema.safeParse({ query: '  ' }).success, false);
    assert.equal(tool.inputSchema.safeParse({ query: 'x'.repeat(501) }).success, false);
    assert.equal(tool.inputSchema.safeParse({ query: 'ok' }).success, true);
});

test('runTurn falls back to the next model when the first fails before output', async (t) => {
    t.mock.method(console, 'error', () => {});
    const first = scriptedModel(failingStep());
    const second = scriptedModel(answerStep('Backup'));
    const byId = { [models[0].id]: first, [models[1].id]: second };
    const events = await collect(
        runTurn({ env: ENV, query: 'q', history: [], languageModel: (model) => byId[model.id], instance: fakeSearchInstance() }),
    );
    assert.equal(events.find((event) => event.metrics).metrics.generationModel, models[1].id);
    assert.ok(events.some((event) => event.response === 'Backup'));
});
