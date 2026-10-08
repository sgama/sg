import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publicSourceUrls } from '../../scripts/lib/source-provenance.mjs';

test('Hugo owns URL provenance for slugs, explicit URLs, sections and permalink rules', async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'sg-provenance-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'content/posts'), { recursive: true });
    await writeFile(path.join(root, 'hugo.toml'), 'baseURL = "https://example.com"\n[permalinks]\nposts = "/writing/:slug/"\n');
    for (const [name, content] of Object.entries({
        '_index.md': '---\ntitle: Home\n---\nHome',
        'posts/_index.md': '---\ntitle: Posts\n---\nPosts',
        'posts/date-prefixed.md': '---\ntitle: A title with a comma, and quotes\nslug: actual-slug\n---\nFacts',
        'posts/custom.md': '---\ntitle: Custom\nurl: /custom-location/\n---\nFacts',
        'posts/draft.md': '---\ntitle: Draft\ndraft: true\n---\nFacts',
    }))
        await writeFile(path.join(root, 'content', name), content);
    const urls = await publicSourceUrls(root);
    assert.equal(urls.get('content/_index.md'), '/');
    assert.equal(urls.get('content/posts/_index.md'), '/posts/');
    assert.equal(urls.get('content/posts/date-prefixed.md'), '/writing/actual-slug/');
    assert.equal(urls.get('content/posts/custom.md'), '/custom-location/');
    assert.equal(urls.has('content/posts/draft.md'), false);
    await assert.rejects(publicSourceUrls(root, { hugo: '/missing/hugo' }), /ENOENT/);
});
