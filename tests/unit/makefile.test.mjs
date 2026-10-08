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

test('local GPU targets do not invoke cloud commands and have explicit cache cleanup', () => {
    const result = make('-n', 'ai-local-validate', 'ai-local-clean');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /ai-local-eval\.mjs --dry-run/);
    assert.match(result.stdout, /bash scripts\/run_local_ai\.sh\n/);
    assert.match(result.stdout, /bash scripts\/run_local_ai\.sh clean/);
    assert.doesNotMatch(result.stdout, /check-env|ai-refresh|ai-eval\.mjs|wrangler|deploy/);
});

test('npm delegates tests and coverage to bounded Make commands without cycles', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(scripts.test, 'make --no-print-directory test');
    assert.equal(scripts['test:coverage'], 'make --no-print-directory coverage');
    const result = make('-n', 'test', 'coverage', 'NODE=custom-node', 'HUGO=custom-hugo', 'TEST_REPORTER=dot');
    assert.equal(result.status, 0);
    const commands = result.stdout.split('\n').filter((line) => line.includes('--test-reporter'));
    assert.equal(commands.length, 2);
    assert.ok(commands.every((command) => command.includes('--test-timeout=30000')));
    assert.ok(commands.every((command) => command.includes('--test-reporter=dot')));
    assert.ok(commands.every((command) => command.includes('custom-node --test')));
    assert.ok(commands.every((command) => !command.includes('--test-concurrency')));
    assert.match(result.stdout, /command -v custom-hugo/);
    assert.match(result.stdout, /custom-node node_modules\/c8\/bin\/c8\.js custom-node --test/);
    assert.doesNotMatch(result.stdout, /npm.*(?:run test:coverage|test)\b/);
    const coverage = make('-n', 'coverage');
    assert.match(coverage.stdout, /Missing Hugo/);
    const removed = make('-n', 'ai-test');
    assert.notEqual(removed.status, 0);
    assert.match(removed.stderr, /No rule to make target/);
});

test('metrics delegate to native scc without installing or counting generated trees', () => {
    for (const target of ['bom', 'metrics', 'metrics-json']) {
        const result = make('-n', target);
        assert.equal(result.status, 0);
        assert.match(result.stdout, /--exclude-dir \.git,node_modules,public,resources,reports,coverage,\.wrangler,\.npm/);
        assert.match(result.stdout, /--exclude-file site\.purged\.css,package-lock\.json,go\.sum/);
        assert.match(result.stdout, /--no-cocomo/);
        assert.match(result.stdout, target === 'metrics-json' ? /--format json \./ : /--wide \./);
        assert.doesNotMatch(result.stdout, /^\s*(?:go install|npm|hugo|wrangler)\b/m);
    }
    const missing = make('metrics-json', 'SCC=sg-nonexistent-scc-command');
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /Missing scc/);
});

test('npm build and development delegate to Make without cycles', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(scripts.build, 'make --no-print-directory build-prod');
    assert.equal(scripts.dev, 'make --no-print-directory dev-ai');
    const result = make('-n', 'build-prod', 'dev-ai');
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /npm.*run (build|dev)\b/);
    assert.match(result.stdout, /--port=8788/);
});
