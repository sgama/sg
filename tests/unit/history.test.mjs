import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHistory } from '../../functions/_lib/history.js';

const LIMITS = { maxTurns: 4, maxContentLength: 2000 };

test('returns [] for non-array input', () => {
    assert.deepEqual(sanitizeHistory(null, LIMITS), []);
    assert.deepEqual(sanitizeHistory(undefined, LIMITS), []);
    assert.deepEqual(sanitizeHistory('string', LIMITS), []);
    assert.deepEqual(sanitizeHistory({ role: 'user' }, LIMITS), []);
});

test('drops turns with invalid roles', () => {
    const input = [
        { role: 'system', content: 'bad' },
        { role: 'user', content: 'ok' },
        { role: 'tool', content: 'bad' },
    ];
    assert.deepEqual(sanitizeHistory(input, LIMITS), [{ role: 'user', content: 'ok' }]);
});

test('drops empty or non-string content', () => {
    const input = [
        { role: 'user', content: '' },
        { role: 'user', content: 42 },
        { role: 'user', content: 'valid' },
    ];
    assert.deepEqual(sanitizeHistory(input, LIMITS), [{ role: 'user', content: 'valid' }]);
});

test('drops turns exceeding maxContentLength', () => {
    const input = [
        { role: 'user', content: 'x'.repeat(5) },
        { role: 'user', content: 'x'.repeat(3000) },
    ];
    const result = sanitizeHistory(input, { maxTurns: 10, maxContentLength: 2000 });
    assert.equal(result.length, 1);
});

test('keeps only the most recent maxTurns', () => {
    const input = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const result = sanitizeHistory(input, { maxTurns: 3, maxContentLength: 2000 });
    assert.deepEqual(result.map(m => m.content), ['m7', 'm8', 'm9']);
});

test('strips unknown properties from message objects', () => {
    const input = [{ role: 'user', content: 'hi', secret: 'leak', name: 'nope' }];
    assert.deepEqual(sanitizeHistory(input, LIMITS), [{ role: 'user', content: 'hi' }]);
});
