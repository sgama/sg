import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatResponseMetrics } from '../../assets/js/chat/model/metrics.js';
import { AI_CONFIG, estimateCost, getModel } from '../../shared/ai/application.js';
import { createResponseMetrics } from '../../shared/ai/response-metrics.js';

test('missing usage never becomes a zero-cost success or invented token count', () => {
    const formatted = formatResponseMetrics({ totalMs: 10, firstTokenMs: null, estimatedLlmCostUsd: null });
    assert.deepEqual(formatted.usage, [['Answer', 'Unavailable', 'Unavailable']]);
    assert.equal(formatted.summary, '🕧10ms · Cost unavailable');
    assert.deepEqual(formatted.timing, []);
    for (const metrics of [null, {}, { totalMs: -1 }, { totalMs: NaN }]) assert.equal(formatResponseMetrics(metrics), null);
});

test('response footer formats timings, token counts and estimated cost', () => {
    const formatted = formatResponseMetrics({
        totalMs: 2400,
        firstTokenMs: 1250,
        generationUsage: { prompt_tokens: 1000, completion_tokens: 100 },
        estimatedLlmCostUsd: 0.0001,
    });
    assert.equal(formatted.summary, '🕧2.40s · 🪙1.25s · 💲0.000100');
    assert.deepEqual(formatted.usage, [['Answer', '1,000', '100']]);
    assert.equal(formatted.warning, 'AI answers may be inaccurate. 🤥🤖');
});

test('response metrics never invent a model, token count or cost', () => {
    const metrics = createResponseMetrics({ now: () => 0 });
    assert.deepEqual(metrics.snapshot({}), {
        totalMs: 0,
        firstTokenMs: null,
        generationModel: null,
        generationUsage: null,
        estimatedLlmCostUsd: null,
        pricingDate: AI_CONFIG.pricingDate,
    });
    assert.equal(metrics.snapshot({ model: getModel() }).estimatedLlmCostUsd, null);
});

test('response metrics report timings, model, usage and cost from the injected clock', () => {
    let clock = 100;
    const metrics = createResponseMetrics({ now: () => clock });
    const model = getModel('gemma');
    const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
    clock = 350;
    metrics.firstToken();
    clock = 400;
    metrics.firstToken();
    clock = 900;
    assert.deepEqual(metrics.snapshot({ model, usage }), {
        totalMs: 800,
        firstTokenMs: 250,
        generationModel: model.id,
        generationUsage: usage,
        estimatedLlmCostUsd: estimateCost(usage, model),
        pricingDate: AI_CONFIG.pricingDate,
    });
});

test('shared token pricing rejects invalid usage and uses the configured model rates', () => {
    const model = getModel();
    assert.equal(estimateCost({ prompt_tokens: 1000000, completion_tokens: 1000000 }, model), model.inputPerMillion + model.outputPerMillion);
    for (const usage of [
        null,
        {},
        { prompt_tokens: -1, completion_tokens: 1 },
        { prompt_tokens: 1, completion_tokens: -2 },
        { prompt_tokens: 1, completion_tokens: Infinity },
        { prompt_tokens: 1, completion_tokens: '2' },
    ]) {
        assert.equal(estimateCost(usage, model), null);
    }
});
