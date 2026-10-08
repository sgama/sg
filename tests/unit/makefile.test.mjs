import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const make = (...args) => {
    const result = spawnSync('make', ['--no-print-directory', ...args], {
        cwd: root, encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    return result;
};

test('audits do not implicitly install dependencies', () => {
    const result = make('-n', 'audit-site');
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /\bnpm (?:ci|install)\b/);
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

test('Make and npm bound tests and coverage with native Node timeouts', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    for (const name of ['test', 'test:coverage']) {
        assert.match(scripts[name], /--test-timeout=30000\b/);
        assert.doesNotMatch(scripts[name], /--test-concurrency\b/);
    }
    const result = make('-n', 'test', 'ai-test');
    assert.equal(result.status, 0);
    const commands = result.stdout.split('\n').filter(line => line.includes('--test-reporter'));
    assert.equal(commands.length, 2);
    assert.ok(commands.every(command => command.includes('--test-timeout=30000')));
    assert.ok(commands.every(command => !command.includes('--test-concurrency')));
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
