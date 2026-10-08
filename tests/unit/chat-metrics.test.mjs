import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatResponseMetrics } from '../../assets/js/chat/metrics.js';
import { AI_CONFIG, getModel, estimateCost } from '../../functions/_lib/application.js';
import { AiService } from '../../functions/_lib/ai.js';
import { makeProviderStream } from '../helpers/mocks.mjs';

test('response footer formats timings, token counts and scoped estimated cost', () => {
    const formatted = formatResponseMetrics({
        totalMs: 2400,
        firstTokenMs: 1250,
        embeddingMs: 45,
        retrievalMs: 12,
        rewriteMs: 250,
        rewriteUsed: true,
        generationUsage: { prompt_tokens: 1000, completion_tokens: 100 },
        rewriteUsage: { prompt_tokens: 50, completion_tokens: 10 },
        estimatedLlmCostUsd: 0.0001,
    });
    assert.equal(formatted.summary, '🕧2.40s · 🪙1.25s · 💲0.000100');
    assert.deepEqual(formatted.timing, [
        ['Rewrite', '250ms'],
        ['Embed', '45ms'],
        ['Search', '12ms'],
    ]);
    assert.deepEqual(formatted.usage, [
        ['Answer', '1,000', '100'],
        ['Rewrite', '50', '10'],
    ]);
    assert.equal(formatted.warning, 'AI answers may be inaccurate. 🤥🤖');
});

test('missing usage never becomes a zero-cost success or invented token count', () => {
    const formatted = formatResponseMetrics({ totalMs: 10, firstTokenMs: null, estimatedLlmCostUsd: null });
    assert.deepEqual(formatted.usage, [['Answer', 'Unavailable', 'Unavailable']]);
    assert.equal(formatted.summary, '🕧10ms · Cost unavailable');
    assert.deepEqual(formatted.timing, []);
    for (const metrics of [null, {}, { totalMs: -1 }, { totalMs: NaN }]) assert.equal(formatResponseMetrics(metrics), null);
    const abstain = formatResponseMetrics({ totalMs: 10, abstained: true, estimatedLlmCostUsd: 0 });
    assert.equal(abstain.abstained, true);
    assert.deepEqual(abstain.usage, []);
    assert.match(abstain.summary, /💲0.000000/);
});

test('shared token pricing rejects invalid usage and uses the configured model rates', () => {
    const model = getModel();
    assert.equal(estimateCost({ prompt_tokens: 1000000, completion_tokens: 1000000 }, model), model.inputPerMillion + model.outputPerMillion);
    for (const usage of [null, {}, { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: 1, completion_tokens: Infinity }]) {
        assert.equal(estimateCost(usage, model), null);
    }
});

test('service emits one final metrics event with actual model, aggregate usage and rewrite cost', async () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
    const rewriteUsage = { prompt_tokens: 50, completion_tokens: 10 };
    const svc = new AiService({
        AI_MODEL: 'gemma',
        AI: {
            async run(_model, input) {
                if (input.stream === false) return { response: 'Standalone question', usage: rewriteUsage };
                if (input.text) return { data: [[0.1, 0.2]] };
                return makeProviderStream('Answer', usage);
            },
        },
        VECTORIZE_INDEX: { query: async () => ({ matches: [{ metadata: { recordType: 'chunk', text: 'Evidence' } }] }) },
    });
    const context = await svc.retrieveContext('Follow-up?', [{ role: 'user', content: 'Earlier question' }]);
    const output = await new Response(await svc.generateStream('Follow-up?', context)).text();
    const events = output
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
    const metrics = events.filter((event) => event.metrics).map((event) => event.metrics);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].generationModel, getModel('gemma').id);
    assert.deepEqual(metrics[0].generationUsage, usage);
    assert.deepEqual(metrics[0].rewriteUsage, rewriteUsage);
    assert.equal(
        metrics[0].estimatedLlmCostUsd,
        estimateCost(usage, getModel('gemma')) + estimateCost(rewriteUsage, getModel(AI_CONFIG.contextualization.model)),
    );
    assert.ok(metrics[0].totalMs >= metrics[0].firstTokenMs);
    assert.ok(output.indexOf('"metrics"') < output.indexOf('[DONE]'));
});

test('service marks abstention and incomplete rewrite billing honestly', async () => {
    const svc = new AiService({ AI: { run: async () => ({ response: 'Standalone question' }) } });
    assert.equal(svc.responseMetrics({ abstained: true }).estimatedLlmCostUsd, 0);
    await svc.contextualizeQuery('Follow-up?', [{ role: 'user', content: 'Earlier question' }]);
    const metrics = svc.responseMetrics({ abstained: true });
    assert.equal(metrics.generationModel, null);
    assert.equal(metrics.estimatedLlmCostUsd, null);
    assert.equal(metrics.rewriteUsed, true);
});
