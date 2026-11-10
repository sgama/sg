import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/generate_csp.mjs', import.meta.url));

const STATIC_HEADERS = `/*.png
  Cache-Control: public, max-age=604800

/*
  X-Frame-Options: DENY
`;

/** Run the generator against a temporary site and return the emitted public/_headers. */
async function generate(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'sg-csp-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'static'));
    await mkdir(path.join(root, 'public'));
    await writeFile(path.join(root, 'static/_headers'), STATIC_HEADERS);
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return readFile(path.join(root, 'public/_headers'), 'utf8');
}

test('generate_csp emits HSTS and the expected CSP directives', async (t) => {
    const headers = await generate(t);
    assert.match(headers, /^ {2}Strict-Transport-Security: max-age=63072000; includeSubDomains$/m);
    for (const directive of [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://ping.samsongama.com",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' https://ping.samsongama.com",
        "img-src 'self' data:",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self' https://formspree.io",
    ]) {
        assert.ok(headers.includes(directive), directive);
    }
});

test('generate_csp keeps one catch-all block and preserves static rules', async (t) => {
    const headers = await generate(t);
    assert.ok(headers.includes('/*.png\n  Cache-Control: public, max-age=604800'));
    assert.ok(headers.includes('  X-Frame-Options: DENY'));
    assert.equal(headers.match(/^\/\*$/gm).length, 1);
});
