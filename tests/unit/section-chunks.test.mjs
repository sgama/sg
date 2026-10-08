import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { AI_CONFIG, corpusRecordId } from '../../functions/_lib/application.js';
import { corpusFixture as fixture } from '../helpers/corpus.mjs';

test('generic parent records are bounded, linked, source-specific and updated with content', async (t) => {
    const body = 'Deployment detail and rollback instructions. '.repeat(200);
    const root = await fixture(t, {
        'content/posts/project/index.md': `---\ntitle: Project\n---\n## Deployment\n\n${body}\n\n## Monitoring\n\nAlerts`,
        'content/_context/project.md': `## Deployment\n\n${body}`,
    });
    const corpus = await buildCorpus({ root });
    assert.equal(corpus.version, 2);
    const parents = corpus.chunks.filter((chunk) => chunk.metadata.recordType === 'section');
    assert.ok(parents.length >= 4);
    assert.ok(parents.every((chunk) => chunk.text.length <= AI_CONFIG.retrieval.maxSectionChars));
    assert.ok(parents.filter((chunk) => chunk.metadata.type === 'context').every((chunk) => !Object.hasOwn(chunk.metadata, 'url')));
    const children = corpus.chunks.filter((chunk) => Number.isInteger(chunk.metadata.parentIndex));
    assert.ok(children.length);
    for (const child of children) {
        const parent = parents.find((chunk) => chunk.metadata.source === child.metadata.source && chunk.chunkIndex === child.metadata.parentIndex);
        assert.ok(parent.text.includes(child.text));
        assert.equal(parent.id, await corpusRecordId(corpus.namespace, child.metadata.source, child.metadata.parentIndex));
        assert.equal(parent.metadata.section, 'Deployment');
    }
    await writeFile(path.join(root, 'content/posts/project/index.md'), '## Deployment\n\nUpdated source.');
    assert.notEqual((await buildCorpus({ root })).namespace, corpus.namespace);
});
