import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const make = (...args) => spawnSync('make', ['--no-print-directory', ...args], {
    cwd: root, encoding: 'utf8',
});

test('cleanup rejects empty, broad, source, and out-of-tree destinations', () => {
    for (const destination of ['', '/', root, process.env.HOME, 'content', 'public/..', '../outside']) {
        const result = make('clean', `PUBLIC_DIR=${destination}`);
        assert.notEqual(result.status, 0, destination);
        assert.match(result.stdout + result.stderr, /Refusing cleanup/, destination);
    }
});

test('audits do not implicitly install dependencies', () => {
    const result = make('-n', 'audit-site');
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /\bnpm (?:ci|install)\b/);
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
