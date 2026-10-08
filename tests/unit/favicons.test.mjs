import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/generate_favicons.sh', import.meta.url));

test('favicon tooling supports ImageMagick 6/7, current source and explicit failures without installation', async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'sg-favicons-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.resolve('assets/samson.webp');
    for (const tool of ['magick', 'convert']) {
        const bin = path.join(root, tool);
        await mkdir(bin);
        await writeFile(path.join(bin, tool), '#!/bin/bash\nprintf "%s\\n" "$@" >> "$CALLS"\nprintf "fixture" > "${@: -1}"\n', { mode: 0o755 });
        const calls = path.join(root, `${tool}.log`);
        const output = path.join(root, `${tool}-output`);
        const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CALLS: calls, FAVICON_SOURCE: source, FAVICON_OUTPUT_DIR: output };
        const result = spawnSync('/bin/bash', [script], { env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        for (const file of [
            'android-chrome-192x192.png',
            'android-chrome-512x512.png',
            'apple-touch-icon.png',
            'favicon-16x16.png',
            'favicon-32x32.png',
            'favicon.ico',
        ]) {
            assert.equal(await readFile(path.join(output, file), 'utf8'), 'fixture');
        }
        assert.match(await readFile(calls, 'utf8'), /icon:auto-resize=64,48,32,16/);
        const missing = spawnSync('/bin/bash', [script], { env: { ...env, FAVICON_SOURCE: '/missing/source.webp' }, encoding: 'utf8' });
        assert.equal(missing.status, 1);
        assert.match(missing.stderr, /Missing favicon source/);
    }
    const missingTool = spawnSync('/bin/bash', [script], { env: { PATH: root }, encoding: 'utf8' });
    assert.equal(missingTool.status, 1);
    assert.match(missingTool.stderr, /Missing ImageMagick/);
});
