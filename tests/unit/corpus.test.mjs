import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { corpusHash, instanceFor, validateCorpus } from '../../scripts/lib/corpus-contract.mjs';
import { corpusFixture as fixture, integrityFixture } from '../helpers/corpus.mjs';

test('authoring comments are excluded from internal items and comment-only files are empty', async (t) => {
    const root = await fixture(t, {
        'content/_context/profile.md':
            '---\ntitle: Profile\n---\nKnown fact.\n<!-- FILL IN: private placeholder\nmore instructions -->\nAnother fact.',
        'content/_context/placeholder.md': '<!-- FILL IN: availability -->',
        'content/page.md': 'Public body. <!-- Existing public comment -->',
    });
    const corpus = await buildCorpus({ root });
    assert.equal(corpus.counts.emptyFiles, 1);
    const internal = corpus.items.filter((item) => item.key.startsWith('content/_context/'));
    assert.equal(internal.length, 1);
    assert.match(internal[0].text, /Known fact/);
    assert.match(internal[0].text, /Another fact/);
    assert.doesNotMatch(internal[0].text, /FILL IN|private placeholder|<!--/);
    assert.ok(!Object.hasOwn(internal[0].metadata, 'url'));
    assert.equal(corpus.items.find((item) => item.key === 'content/page.md').text, 'Public body.');
    await writeFile(path.join(root, 'content/_context/profile.md'), 'Known fact. <!-- unfinished');
    await assert.rejects(buildCorpus({ root }), /Unclosed authoring comment/);
});

test('context items cite the page they link to, and invalid links are rejected', async (t) => {
    const root = await fixture(t, {
        'content/_context/project.md':
            '---\ntitle: Project facts\nretrievalSource: content/posts/project/index.md\nretrievalSection: Deployment\n---\nSpecific facts.',
        'content/posts/project/index.md': '---\ntitle: Project\n---\n## Deployment\n\nCanonical facts.',
    });
    const corpus = await buildCorpus({ root });
    assert.deepEqual(corpus.items.find((item) => item.key === 'content/_context/project.md').metadata, {
        title: 'Project facts',
        url: '/posts/project/',
    });
    for (const target of ['content/missing.md', 'content/_context/project.md', '42']) {
        await writeFile(path.join(root, 'content/_context/project.md'), `---\nretrievalSource: ${target}\n---\nFacts`);
        await assert.rejects(buildCorpus({ root }), /Invalid retrieval source/);
    }
});

test('corpus contract rejects invalid shapes and inconsistent items even with recomputed hashes', async (t) => {
    const corpus = await buildCorpus({
        root: await fixture(t, { 'content/page.md': '---\ntitle: Page\n---\nEvidence.' }),
        sourceUrls: new Map([['content/page.md', '/page/']]),
    });
    for (const [mutate, expected] of [
        [(value) => delete value.index.normalizationVersion, /invalid_value/],
        [(value) => (value.items[0].text = ''), /too_small/],
        [(value) => (value.items[0].key = 'k'.repeat(129)), /too_big/],
        [(value) => (value.items[0].key = 'bad"key.md'), /invalid_format/],
        [(value) => (value.counts.items += 1), /counts/],
        [(value) => (value.items[0].metadata.url = undefined), /missing its URL/],
        [(value) => (value.items[0].metadata.url = '/a\\b'), /Invalid public item URL/],
        [(value) => (value.items[0].metadata.url = '//evil.example'), /Invalid public item URL/],
        [(value) => (value.items[0].metadata.url = '/_context/private/'), /Invalid public item URL/],
        [(value) => (value.items[0].key = 'content/other.md'), /not included/],
        [(value) => value.items.push(structuredClone(value.items[0])), /Duplicate corpus item key/],
    ]) {
        const changed = structuredClone(corpus);
        mutate(changed);
        changed.hash = corpusHash(changed);
        changed.instance = instanceFor(changed.hash);
        assert.throws(() => validateCorpus(changed), expected);
    }
});

test('corpus items are one per included source, sorted, with page metadata', async (t) => {
    const corpus = await buildCorpus({ root: await fixture(t) });
    assert.deepEqual(corpus.counts, { files: 5, includedFiles: 3, draftFiles: 1, emptyFiles: 1, items: 3 });
    assert.match(corpus.instance, /^portfolio-[a-f0-9]{12}$/);
    assert.equal(corpus.instance, `portfolio-${corpus.hash.slice(0, 12)}`);
    assert.deepEqual(
        corpus.items.map((item) => item.key),
        ['content/_context/private.md', 'content/posts/first/index.md', 'content/posts/second/index.md'],
    );
    assert.deepEqual(corpus.items[0].metadata, { title: 'Internal' });
    assert.deepEqual(corpus.items[1].metadata, { title: 'First', url: '/posts/first/' });
    assert.equal(corpus.items[1].text, 'First source body.');
});

test('file parsing errors reject rather than silently skipping files', async (t) => {
    const root = await fixture(t, { 'content/bad.md': '---\ntitle: [invalid\n---\nBody' });
    await assert.rejects(buildCorpus({ root }));
});

test('hash and instance repeat deterministically and change with sources or index configuration', async (t) => {
    const root = await fixture(t);
    const original = await buildCorpus({ root });
    assert.deepEqual(await buildCorpus({ root }), original);
    for (const options of [
        { embedding: { model: 'different-model' } },
        { search: { chunkSize: 1000, chunkOverlap: 100, reranker: original.index.reranker } },
        { search: { chunkSize: original.index.chunkSize, chunkOverlap: original.index.chunkOverlap, reranker: 'different-reranker' } },
    ]) {
        const changed = await buildCorpus({ root, ...options });
        assert.notEqual(changed.hash, original.hash);
        assert.notEqual(changed.instance, original.instance);
    }
    await writeFile(path.join(root, 'content/_context/private.md'), 'Changed context.');
    assert.notEqual((await buildCorpus({ root })).instance, original.instance);
});

test('invalid embedding and chunk configurations reject before corpus generation', async (t) => {
    const { root } = await integrityFixture(t);
    for (const embedding of [{ model: '' }, { model: 42 }]) {
        await assert.rejects(buildCorpus({ root, embedding }), /Invalid embedding configuration/);
    }
    for (const [chunkSize, chunkOverlap] of [
        [0, 0],
        [5, -1],
        [5, 5],
        [5, 1.5],
    ]) {
        await assert.rejects(buildCorpus({ root, search: { chunkSize, chunkOverlap, reranker: 'r' } }), /Invalid chunk configuration/);
    }
});

test('tampered hashes and instances fail integrity validation', async (t) => {
    const { corpus } = await integrityFixture(t);
    for (const [mutate, expected] of [
        [(value) => (value.items[0].text = 'Tampered.'), /Corpus hash or instance/],
        [(value) => (value.instance = `portfolio-${'0'.repeat(12)}`), /Corpus hash or instance/],
    ]) {
        const changed = structuredClone(corpus);
        mutate(changed);
        assert.throws(() => validateCorpus(changed), expected);
    }
});
