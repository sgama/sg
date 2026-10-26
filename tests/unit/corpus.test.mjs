import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AI_CONFIG } from '../../functions/_lib/application.js';
import { corpusRecordId, expandSectionMatches, parentSectionIds } from '../../functions/_lib/retrieval.js';
import { buildCorpus, embeddingText } from '../../scripts/lib/corpus.mjs';
import { chunkId, corpusHash, namespaceFor, validateCorpus } from '../../scripts/lib/corpus-contract.mjs';
import { corpusFixture as fixture, integrityFixture } from '../helpers/corpus.mjs';

test('authoring comments are excluded from internal chunks and comment-only files are empty', async (t) => {
    const root = await fixture(t, {
        'content/_context/profile.md':
            '---\ntitle: Profile\n---\nKnown fact.\n<!-- FILL IN: private placeholder\nmore instructions -->\nAnother fact.',
        'content/_context/placeholder.md': '<!-- FILL IN: availability -->',
        'content/page.md': 'Public body. <!-- Existing public comment -->',
    });
    const corpus = await buildCorpus({ root });
    assert.equal(corpus.counts.emptyFiles, 1);
    const internal = corpus.chunks.filter((chunk) => chunk.metadata.type === 'context');
    assert.equal(internal.length, 1);
    assert.match(internal[0].text, /Known fact/);
    assert.match(internal[0].text, /Another fact/);
    assert.doesNotMatch(internal[0].text, /FILL IN|private placeholder|<!--/);
    assert.ok(!Object.hasOwn(internal[0].metadata, 'url'));
    assert.equal(corpus.chunks.find((chunk) => chunk.metadata.type === 'content').text, 'Public body.');
    await writeFile(path.join(root, 'content/_context/profile.md'), 'Known fact. <!-- unfinished');
    await assert.rejects(buildCorpus({ root }), /Unclosed authoring comment/);
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

test('corpus contracts reject invalid shapes and inconsistent evidence even with recomputed hashes', async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'sg-contract-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'content'));
    await writeFile(path.join(root, 'content/page.md'), '---\ntitle: Page\n---\nEvidence.');
    const corpus = await buildCorpus({ root, sourceUrls: new Map([['content/page.md', '/page/']]) });
    for (const [mutate, expected] of [
        [
            (value) => {
                delete value.chunks[0].metadata.recordType;
            },
            /invalid_value/,
        ],
        [
            (value) => {
                delete value.chunking.normalizationVersion;
            },
            /invalid_value/,
        ],
        [
            (value) => {
                value.chunks[0].metadata.parentIndex = 'bad';
            },
            /invalid_type/,
        ],
        [
            (value) => {
                value.chunks[0].metadata.text = 'Different evidence';
            },
            /Inconsistent evidence/,
        ],
        [
            (value) => {
                value.counts.chunks++;
            },
            /counts/,
        ],
        [
            (value) => {
                value.chunks[0].metadata.parentIndex = -1;
            },
            /Missing or invalid parent/,
        ],
        [
            (value) => {
                value.chunks[0].metadata.parentSource = 'content/other.md';
            },
            /Invalid parent source/,
        ],
        [
            (value) => {
                value.chunks[0].metadata.canonicalIndex = -1;
            },
            /Missing canonical source/,
        ],
        [
            (value) => {
                value.chunks[0].chunkIndex = -1;
            },
            /Invalid child record/,
        ],
        [
            (value) => {
                const section = structuredClone(value.chunks[0]);
                section.chunkIndex = -1;
                section.metadata.recordType = 'section';
                section.metadata.sectionIndex = -2;
                value.chunks.push(section);
            },
            /Invalid parent section/,
        ],
        [
            (value) => {
                value.chunks[0].metadata.url = undefined;
            },
            /missing its URL/,
        ],
        [
            (value) => {
                value.chunks[0].metadata.url = '/a\\b';
            },
            /Invalid public evidence URL/,
        ],
        [
            (value) => {
                value.chunks[0].metadata.type = 'context';
            },
            /Internal evidence/,
        ],
    ]) {
        const changed = structuredClone(corpus);
        mutate(changed);
        changed.hash = corpusHash(changed);
        changed.namespace = namespaceFor(changed.hash);
        for (const chunk of changed.chunks) chunk.id = chunkId(changed.namespace, chunk.metadata.source, chunk.chunkIndex);
        assert.throws(() => validateCorpus(changed), expected);
    }
});

test('corpus IDs distinguish full source paths and chunk indices; canonical metadata', async (t) => {
    const root = await fixture(t);
    const corpus = await buildCorpus({ root });
    assert.deepEqual(corpus.counts, {
        files: 5,
        includedFiles: 3,
        draftFiles: 1,
        emptyFiles: 1,
        chunks: 3,
    });
    assert.equal(new Set(corpus.chunks.map((chunk) => chunk.id)).size, 3);
    assert.ok(corpus.chunks.every((chunk) => chunk.id.length === 64));
    assert.match(corpus.namespace, /^corpus-[a-f0-9]{56}$/);
    assert.deepEqual(
        corpus.sources.map(({ source }) => source),
        corpus.sources.map(({ source }) => source).sort(),
    );
    const internal = corpus.chunks.find((chunk) => chunk.metadata.type === 'context');
    assert.equal(internal.metadata.source, 'content/_context/private.md');
    assert.ok(!Object.hasOwn(internal.metadata, 'url'));
    const publicChunk = corpus.chunks.find((chunk) => chunk.metadata.title === 'First');
    assert.equal(publicChunk.metadata.url, '/posts/first/');
    assert.equal(publicChunk.text, publicChunk.metadata.text);
    await writeFile(path.join(root, 'content/posts/first/index.md'), 'First paragraph.\n\nSecond paragraph.');
    const split = await buildCorpus({ root, chunking: { chunkSize: 20, chunkOverlap: 2 } });
    const firstChunks = split.chunks.filter((chunk) => chunk.metadata.source === publicChunk.metadata.source);
    assert.ok(firstChunks.length > 1);
    assert.equal(new Set(firstChunks.map((chunk) => chunk.id)).size, firstChunks.length);
});

test('embedding text includes title and section labels', () => {
    assert.equal(embeddingText({ text: 'Facts', metadata: { title: 'Project', section: 'Deployment' } }), 'Project — Deployment\n\nFacts');
});

test('file parsing errors reject rather than silently skipping files', async (t) => {
    const root = await fixture(t, { 'content/bad.md': '---\ntitle: [invalid\n---\nBody' });
    await assert.rejects(buildCorpus({ root }));
});

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

test('hash and IDs repeat deterministically and change with corpus or embedding/chunk configuration', async (t) => {
    const root = await fixture(t);
    const original = await buildCorpus({ root });
    assert.deepEqual(await buildCorpus({ root }), original);
    for (const options of [
        { embedding: { ...original.embedding, model: 'different-model' } },
        { embedding: { ...original.embedding, dimensions: 3 } },
        { chunking: { chunkSize: 1000, chunkOverlap: 100 } },
    ]) {
        const changed = await buildCorpus({ root, ...options });
        assert.notEqual(changed.hash, original.hash);
        assert.notEqual(changed.namespace, original.namespace);
        assert.notEqual(changed.chunks[0].id, original.chunks[0].id);
    }
    await writeFile(path.join(root, 'content/_context/private.md'), 'Changed context.');
    assert.notEqual((await buildCorpus({ root })).namespace, original.namespace);
});

test('invalid embedding and chunk configurations reject before corpus generation', async (t) => {
    const { root } = await integrityFixture(t);
    for (const embedding of [
        { model: '', dimensions: 2 },
        { model: 'test', dimensions: 0 },
        { model: 'test', dimensions: 1.5 },
    ]) {
        await assert.rejects(buildCorpus({ root, embedding }), /Invalid embedding configuration/);
    }
    for (const chunking of [
        { chunkSize: 0, chunkOverlap: 0 },
        { chunkSize: 5, chunkOverlap: -1 },
        { chunkSize: 5, chunkOverlap: 5 },
        { chunkSize: 5, chunkOverlap: 1.5 },
    ]) {
        await assert.rejects(buildCorpus({ root, chunking }), /Invalid chunk configuration/);
    }
});

test('runtime record IDs match corpus chunk IDs for the same namespace, source and index', async () => {
    for (const [namespace, source, index] of [
        ['corpus-' + 'a'.repeat(56), 'content/posts/a/index.md', 0],
        ['corpus-' + 'a'.repeat(56), 'content/posts/a/index.md', -1],
        ['corpus-' + 'b'.repeat(56), 'content/portfolio/b/index.md', 3],
    ]) {
        assert.equal(await corpusRecordId(namespace, source, index), chunkId(namespace, source, index));
    }
});

test('tampered metadata, namespaces and chunk IDs fail integrity validation', async (t) => {
    const { corpus } = await integrityFixture(t);
    for (const [mutate, expected] of [
        [
            (value) => {
                value.chunks[0].chunkIndex = 99;
            },
            /Corpus hash or namespace/,
        ],
        [
            (value) => {
                value.namespace = `corpus-${'0'.repeat(56)}`;
            },
            /Corpus hash or namespace/,
        ],
        [
            (value) => {
                value.chunks[0].id = 'wrong';
            },
            /Invalid chunk ID/,
        ],
    ]) {
        const changed = structuredClone(corpus);
        mutate(changed);
        assert.throws(() => validateCorpus(changed), expected);
    }
});
