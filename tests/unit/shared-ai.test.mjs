import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_CONFIG, AI_MODELS, getModel } from '../../shared/ai/application.js';
import { SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext } from '../../shared/ai/answer-policy.js';

test('shared AI exports resolve runtime-neutral application config and abstention policy', () => {
    const model = getModel();
    assert.equal(model.id, AI_MODELS[AI_CONFIG.generation.defaultModel].id);
    assert.equal(shouldAbstainForMissingContext(''), true);
    assert.equal(shouldAbstainForMissingContext('   '), true);
    assert.equal(shouldAbstainForMissingContext('x'.repeat(20)), false);
    assert.equal(shouldAbstainForMissingContext('x'.repeat(20), 21), true);
    assert.equal(SAFE_NO_CONTEXT_MESSAGE.includes('portfolio'), true);
});
