import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { parentSectionIds, expandSectionMatches } from '../../functions/_lib/application.js';
import { corpusFixture as fixture } from '../helpers/corpus.mjs';

test('generic curated source linkage expands to a public section regardless of file order', async (t) => {
    const root = await fixture(t, {
        'content/_context/project.md':
            '---\ntitle: Searchable project excerpt\nretrievalSource: content/posts/project/index.md\nretrievalSection: Deployment\n---\nSpecific search phrasing.',
        'content/posts/project/index.md':
            '---\ntitle: Project\n---\n## Deployment\n\nCanonical deployment and rollback facts.\n\n## Other\n\nUnrelated facts.',
        'content/portrait.md': '---\ntitle: Portrait\n---\n{{< figure src="portrait.webp" >}}',
    });
    const corpus = await buildCorpus({ root });
    assert.equal(corpus.counts.emptyFiles, 1);
    const child = corpus.chunks.find((chunk) => chunk.metadata.source === 'content/_context/project.md');
    assert.equal(child.metadata.canonicalSource, 'content/posts/project/index.md');
    const ids = await parentSectionIds([child], corpus.namespace);
    const parents = corpus.chunks.filter((chunk) => ids.includes(chunk.id));
    const expanded = expandSectionMatches([child], parents);
    assert.equal(expanded[0].metadata.url, '/posts/project/');
    assert.match(expanded[0].metadata.text, /Canonical deployment/);
    assert.doesNotMatch(expanded[0].metadata.text, /Unrelated/);
    assert.equal(expanded[1].metadata.text, 'Specific search phrasing.');
    assert.equal(expanded[1].metadata.url, undefined);
    assert.equal(expandSectionMatches([child, child], parents).length, 2);
    for (const canonicalSource of ['', 42, null]) {
        await assert.rejects(parentSectionIds([{ ...child, metadata: { ...child.metadata, canonicalSource } }], corpus.namespace), /Invalid parent/);
    }
    await writeFile(
        path.join(root, 'content/_context/project.md'),
        '---\nretrievalSource: content/missing.md\nretrievalSection: Missing\n---\nFacts',
    );
    await assert.rejects(buildCorpus({ root }), /Missing or ambiguous/);
});

test('canonical linkage rejects ambiguous, internal, draft and oversized target sections', async (t) => {
    for (const [target, text, expected] of [
        ['content/page.md', '## Evidence\nOne\n## Evidence\nTwo', /Missing or ambiguous/],
        ['content/page.md', '## Evidence', /Empty public retrieval section/],
        ['content/_context/private.md', '## Evidence\nInternal facts', /Missing or ambiguous/],
        ['content/page.md', '---\ndraft: true\n---\n## Evidence\nDraft facts', /Missing or ambiguous/],
        ['content/page.md', `## Evidence\n${'Long evidence. '.repeat(500)}`, /exceeds context budget/],
    ]) {
        const root = await fixture(t, {
            'content/_context/link.md': `---\nretrievalSource: ${target}\nretrievalSection: Evidence\n---\nSearchable facts`,
            [target]: text,
        });
        await assert.rejects(buildCorpus({ root }), expected);
    }
});
