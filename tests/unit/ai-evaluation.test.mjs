import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_CONFIG, getModel, generationInput } from '../../functions/_lib/application.js';
import { validateFixture } from '../../scripts/lib/evaluation/fixtures.mjs';
import { scoreAnswer, scoreEvidence, scoreRetrievalQuery } from '../../scripts/lib/evaluation/scoring.mjs';

const item = {
    id: 'known',
    query: 'What is the stack?',
    expectedSources: ['content/a.md'],
    answerTerms: [['hugo'], ['cloudflare']],
    forbiddenTerms: ['wordpress'],
};
const chunks = [{ metadata: { recordType: 'chunk', source: 'content/a.md' } }];

test('answer checks need every term group and no forbidden term', () => {
    assert.equal(scoreAnswer('Hugo on Cloudflare', item), true);
    assert.equal(scoreAnswer('Hugo only', item), false);
    assert.equal(scoreAnswer('Hugo, Cloudflare and WordPress', item), false);
    const cpp = { answerTerms: [['c++', 'c/c++']], forbiddenTerms: ['not listed'] };
    assert.equal(scoreAnswer('Yes, C/C++ is listed in the [resume](/resume/).', cpp), true);
    assert.equal(scoreAnswer('C++ is not listed in the [resume](/resume/).', cpp), false);
});

test('evidence checks score context text, ignoring source metadata lines', () => {
    const labeled = { evidenceTerms: [['hugo'], ['cloudflare']] };
    assert.equal(scoreEvidence('Source: {"title":"Hugo Cloudflare"}\nAn introduction without the facts.', labeled), false);
    assert.equal(scoreEvidence('Source: {"title":"x"}\nHugo builds it and Cloudflare serves it.', labeled), true);
    assert.equal(scoreEvidence('anything', item), null);
});

test('fixture validation checks source labels, unique IDs and label shapes', () => {
    const fixture = { version: 1, cases: [item] };
    validateFixture(fixture, chunks);
    assert.throws(() => validateFixture(fixture, []), /Missing labeled source/);
    assert.throws(() => validateFixture({ version: 1, cases: [item, item] }, chunks), /unique IDs/);
    for (const changes of [
        { required: 'true' },
        { answerTerms: [] },
        { answerTerms: [[]] },
        { answerTerms: [[42]] },
        { forbiddenTerms: [''] },
        { forbiddenTerms: [42] },
        { expectedSources: ['missing'] },
        { query: ' ' },
    ]) {
        assert.throws(() => validateFixture({ version: 1, cases: [{ ...item, ...changes }] }, chunks));
    }
});

test('conversational labels need history and rewritten queries must carry them', () => {
    const history = [{ role: 'user', content: 'Tell me about Bitcomplete' }];
    const conversational = { ...item, history, retrievalTerms: [['bitcomplete']] };
    validateFixture({ version: 1, cases: [conversational] }, chunks);
    assert.throws(() => validateFixture({ version: 1, cases: [{ ...item, retrievalTerms: [['x']] }] }, chunks), /retrieval query labels/);
    assert.equal(scoreRetrievalQuery('Bitcomplete role', conversational), true);
    assert.equal(scoreRetrievalQuery('his role', conversational), false);
});

test('model registry is modular and rejects unknown models', () => {
    assert.equal(getModel('glm').id, getModel('@cf/zai-org/glm-4.7-flash').id);
    assert.throws(() => getModel('typo'), /Unknown AI model/);
    assert.equal(getModel('llama').id, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    const llamaInput = generationInput(getModel('llama'), []);
    assert.equal(llamaInput.max_tokens, AI_CONFIG.generation.maxCompletionTokens);
    assert.equal(llamaInput.max_completion_tokens, undefined);
    assert.equal(generationInput(getModel('gemma'), []).chat_template_kwargs.enable_thinking, false);
});
