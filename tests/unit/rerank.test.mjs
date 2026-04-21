import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRerankPrompt, pickTopK } from '../../functions/_lib/rerank.js';

test('pickTopK orders by descending score', () => {
    const candidates = ['A', 'B', 'C', 'D'];
    const result = pickTopK(candidates, '2, 9, 5, 1', 2);
    assert.deepEqual(result, ['B', 'C']);
});

test('pickTopK falls back to original top-K when scores under-parse', () => {
    const candidates = ['A', 'B', 'C'];
    const result = pickTopK(candidates, 'not, numbers', 2);
    assert.deepEqual(result, ['A', 'B']);
});

test('pickTopK handles noisy whitespace and mixed separators', () => {
    const candidates = ['A', 'B', 'C'];
    const result = pickTopK(candidates, '  3\n 8 , 1  ', 2);
    assert.deepEqual(result, ['B', 'A']);
});

test('pickTopK breaks ties by original order (stable sort)', () => {
    const candidates = ['A', 'B', 'C'];
    const result = pickTopK(candidates, '5, 5, 5', 2);
    assert.deepEqual(result, ['A', 'B']);
});

test('pickTopK treats missing score at position as 0', () => {
    const candidates = ['A', 'B', 'C'];
    // Exactly 3 numeric tokens (passes under-parse check) but middle is 0
    const result = pickTopK(candidates, '1, 0, 9', 2);
    assert.deepEqual(result, ['C', 'A']);
});

test('buildRerankPrompt truncates candidates to snippetChars', () => {
    const long = 'x'.repeat(1000);
    const prompt = buildRerankPrompt('q', [long], 50);
    // Passage body: "[1] " + 50 xs = 54 chars on that line
    assert.ok(prompt.includes('[1] ' + 'x'.repeat(50)));
    assert.ok(!prompt.includes('x'.repeat(51)));
});

test('buildRerankPrompt numbers passages 1-indexed', () => {
    const prompt = buildRerankPrompt('q', ['a', 'b', 'c']);
    assert.match(prompt, /\[1\] a/);
    assert.match(prompt, /\[2\] b/);
    assert.match(prompt, /\[3\] c/);
});
