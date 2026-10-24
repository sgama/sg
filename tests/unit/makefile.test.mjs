import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const make = (...args) => {
    const result = spawnSync('make', ['--no-print-directory', ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
    });
    assert.ifError(result.error);
    return result;
};

test('audits do not implicitly install dependencies', () => {
    const result = make('-n', 'audit-site', 'audit-rag');
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /\bnpm (?:ci|install)\b/);
    assert.match(result.stdout, /scripts\/audit_rag\.mjs/);
    assert.doesNotMatch(result.stdout, /scripts\/(?:ai-eval|generate_embeddings|refresh_ai_corpus)\.mjs/);
});

test('cleanup rejects empty, broad, source, and out-of-tree destinations', () => {
    for (const destination of ['', '/', root, process.env.HOME, 'content', 'public/..', '../outside']) {
        const result = make('clean', `PUBLIC_DIR=${destination}`);
        assert.notEqual(result.status, 0, destination);
        assert.match(result.stdout + result.stderr, /Refusing cleanup/, destination);
    }
});

test('npm scripts delegate to bounded Make commands without cycles', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    for (const [name, command] of Object.entries(scripts)) assert.match(command, /^make --no-print-directory [a-z-]+$/, name);
    const result = make('-n', 'test', 'coverage', 'build-prod', 'dev-ai', 'NODE=custom-node', 'HUGO=custom-hugo', 'TEST_REPORTER=dot');
    assert.equal(result.status, 0);
    const commands = result.stdout.split('\n').filter((line) => line.includes('--test-reporter'));
    assert.equal(commands.length, 2);
    assert.match(result.stdout, /--port=8788/);
    assert.doesNotMatch(result.stdout, /npm.*run /);
    assert.ok(commands.every((command) => command.includes('--test-timeout=30000')));
    assert.ok(commands.every((command) => command.includes('--test-reporter=dot')));
    assert.ok(commands.every((command) => command.includes('custom-node --test')));
    assert.ok(commands.every((command) => !command.includes('--test-concurrency')));
    assert.match(result.stdout, /command -v custom-hugo/);
    assert.match(result.stdout, /custom-node node_modules\/c8\/bin\/c8\.js custom-node --test/);
});
