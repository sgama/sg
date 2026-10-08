import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCorpus, embeddingText } from '../../scripts/lib/corpus.mjs';
import { corpusFixture as fixture, integrityFixture } from '../helpers/corpus.mjs';

test('embedding text includes title and section labels', () => {
    assert.equal(embeddingText({ text: 'Facts', metadata: { title: 'Project', section: 'Deployment' } }), 'Project — Deployment\n\nFacts');
});

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

test('file parsing errors reject rather than silently skipping files', async (t) => {
    const root = await fixture(t, { 'content/bad.md': '---\ntitle: [invalid\n---\nBody' });
    await assert.rejects(buildCorpus({ root }));
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
