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
    const sharedFile = `${root}shared/ai/eslint-boundary-test.js`;
    const chatStreamFile = `${root}shared/ai/chat-stream-boundary-test.js`;
    const allowedFile = `${root}scripts/eslint-boundary-allowed-test.mjs`;
    await writeFile(
        sharedFile,
        "import vm from 'vm';\nimport workerErrors from '../../../../functions/_lib/worker-errors.js';\nconst value = fetch;\nexport default { vm, workerErrors, value };\n",
    );
    await writeFile(
        chatStreamFile,
        "import { EventSourceParserStream } from 'eventsource-parser/stream';\nimport fs from 'node:fs';\nexport default { EventSourceParserStream, fs };\n",
    );
    await writeFile(allowedFile, "import vm from 'node:vm';\nimport { readFile } from 'node:fs/promises';\nexport default { vm, readFile };\n");
    try {
        const eslint = new ESLint({ cwd: root });
        const [sharedResults, chatStreamResults, allowedResults] = await Promise.all([
            eslint.lintFiles([sharedFile]),
            eslint.lintFiles([chatStreamFile]),
            eslint.lintFiles([allowedFile]),
        ]);
        const [sharedResult] = sharedResults;
        const [chatStreamResult] = chatStreamResults;
        const [allowedResult] = allowedResults;
        const sharedErrors = sharedResult.messages.map((entry) => entry.message);
        const chatStreamErrors = chatStreamResult.messages.map((entry) => entry.message);
        assert.ok(sharedErrors.some((message) => message.includes('functions/')));
        assert.ok(sharedErrors.some((message) => message.includes('Node built-ins')) || sharedErrors.some((message) => message.includes('vm')));
        assert.ok(sharedErrors.some((message) => message.includes('fetch')));
        assert.ok(chatStreamErrors.some((message) => message.includes('Node built-ins')));
        assert.ok(!chatStreamErrors.some((message) => message.includes('EventSource parser')));
        assert.equal(allowedResult.messages.length, 0);
    } finally {
        await rm(sharedFile, { force: true });
        await rm(chatStreamFile, { force: true });
        await rm(allowedFile, { force: true });
    }
});
