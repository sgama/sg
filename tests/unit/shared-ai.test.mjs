import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { AI_CONFIG, AI_MODELS, getModel } from '../../shared/ai/application.js';
import { SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext } from '../../shared/ai/answer-policy.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('shared AI exports resolve runtime-neutral application config and abstention policy', () => {
    const model = getModel();
    assert.equal(model.id, AI_MODELS[AI_CONFIG.generation.defaultModel].id);
    assert.equal(shouldAbstainForMissingContext(''), true);
    assert.equal(shouldAbstainForMissingContext('   '), true);
    assert.equal(shouldAbstainForMissingContext('x'.repeat(20)), false);
    assert.equal(shouldAbstainForMissingContext('x'.repeat(20), 21), true);
    assert.equal(SAFE_NO_CONTEXT_MESSAGE.includes('portfolio'), true);
});

test('shared files reject forbidden imports and worker-only globals', async () => {
    const file = `${root}shared/ai/eslint-boundary-test.js`;
    await writeFile(file, "import { Hono } from 'hono';\nconst value = fetch;\nexport default value;\n");
    try {
        const [result] = await new ESLint({ cwd: root }).lintFiles([file]);
        const errors = result.messages.map((entry) => entry.message);
        assert.ok(errors.some((message) => message.includes('Hono')) || errors.some((message) => message.includes('fetch')));
    } finally {
        await rm(file, { force: true });
    }
});
