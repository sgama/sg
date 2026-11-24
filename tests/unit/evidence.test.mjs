import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPublicUrl, searchOutput } from '../../shared/ai/evidence.js';
import { searchChunk } from '../helpers/mocks.mjs';

test('isPublicUrl accepts site paths only', () => {
    for (const url of ['/resume/', '/posts/a/', '/']) assert.equal(isPublicUrl(url), true, url);
    for (const url of [
        undefined,
        null,
        42,
        '',
        'resume',
        '//evil.com',
        'https://x.com/',
        '/_context/a/',
        '/a/_context',
        '/a\\b',
        '/a\nb',
        'content/_context/x.md',
    ])
        assert.equal(isPublicUrl(url), false, String(url));
});

test('searchOutput bounds the text the model reads and skips empty chunks', () => {
    const chunks = [
        searchChunk({ text: 'a'.repeat(10), title: 'A' }),
        { ...searchChunk({ text: 'x' }), text: '   ' },
        searchChunk({ text: 'b'.repeat(10), title: 'B' }),
    ];
    const { results } = searchOutput(chunks, 15);
    assert.deepEqual(results, [
        { title: 'A', text: 'a'.repeat(10) },
        { title: 'B', text: 'b'.repeat(5) },
    ]);
    assert.deepEqual(searchOutput(chunks, 0), { results: [], evidence: [] });
    assert.deepEqual(searchOutput([], 100), { results: [], evidence: [] });
});

test('searchOutput cites each public page once and never internal or unsafe URLs', () => {
    const { results, evidence } = searchOutput(
        [
            searchChunk({ text: 'First resume chunk', title: 'Resume', url: '/resume/' }),
            searchChunk({ text: 'Second resume chunk', title: 'Resume', url: '/resume/' }),
            searchChunk({ text: 'Internal', title: 'Profile', url: '/_context/profile/' }),
            searchChunk({ text: 'Protocol relative', title: 'Evil', url: '//evil.com/x' }),
            searchChunk({ text: 'Absolute', title: 'Abs', url: 'https://evil.com/x' }),
            searchChunk({ text: 'No link', title: 'Unlinked' }),
            searchChunk({ text: 'Untitled', url: '/about/' }),
        ],
        10_000,
    );
    assert.equal(results.length, 7);
    assert.deepEqual(evidence, [
        { title: 'Resume', url: '/resume/', text: 'First resume chunk' },
        { title: 'Source', url: '/about/', text: 'Untitled' },
    ]);
});
