import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';

export async function corpusFixture(
    t,
    files = {
        'content/posts/first/index.md': '---\ntitle: First\n---\nFirst source body.',
        'content/posts/second/index.md': '---\ntitle: Second\n---\nSecond source body.',
        'content/_context/private.md': '---\ntitle: Internal\n---\nInternal context.',
        'content/draft.md': '---\ndraft: true\n---\nNot included.',
        'content/empty.md': '---\ntitle: Empty\n---\n',
    },
) {
    const root = await mkdtemp(path.join(tmpdir(), 'sg-corpus-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await writeFile(path.join(root, name), text);
    }
    return root;
}

export async function integrityFixture(t) {
    const root = await corpusFixture(t, {
        'content/page.md': '---\ntitle: Test\n---\nEvidence.',
        'wrangler.toml': '[vars]\nAI_MODEL = "glm"\n',
    });
    return {
        root,
        configPath: path.join(root, 'wrangler.toml'),
        corpus: await buildCorpus({ root }),
    };
}
