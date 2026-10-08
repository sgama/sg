import { integrityFixture } from '../helpers/corpus.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { validateCorpus, corpusHash, namespaceFor, chunkId } from '../../scripts/lib/corpus-contract.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
                value.chunks[0].metadata.url = undefined;
            },
            /missing its URL/,
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

test('tampered metadata, namespaces and chunk IDs fail integrity validation', async (t) => {
    const { corpus } = await integrityFixture(t);
    for (const mutate of [
        (value) => {
            value.chunks[0].metadata.source = 'content/other.md';
        },
        (value) => {
            value.chunks[0].metadata.text = 'Invented evidence';
        },
        (value) => {
            value.chunks[0].chunkIndex = 99;
        },
        (value) => {
            value.namespace = `corpus-${'0'.repeat(56)}`;
        },
        (value) => {
            value.chunks[0].id = 'wrong';
        },
    ]) {
        const changed = structuredClone(corpus);
        mutate(changed);
        assert.throws(() => validateCorpus(changed), /hash or namespace|Invalid chunk ID/);
    }
});
