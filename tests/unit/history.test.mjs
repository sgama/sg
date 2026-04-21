import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatRequestSchema } from '../../functions/_lib/schemas.js';

const parse = (data) => ChatRequestSchema.safeParse(data);
const ok = (data) => parse(data).success;
const val = (data) => parse(data).data;

test('rejects missing or blank query', () => {
    assert.equal(ok({ query: '' }), false);
    assert.equal(ok({ query: '   ' }), false);
    assert.equal(ok({}), false);
});

test('rejects query over 500 chars', () => {
    assert.equal(ok({ query: 'x'.repeat(501) }), false);
    assert.equal(ok({ query: 'x'.repeat(500) }), true);
});

test('trims query whitespace', () => {
    assert.equal(val({ query: '  hi  ' }).query, 'hi');
});

test('defaults history to [] when omitted', () => {
    assert.deepEqual(val({ query: 'hi' }).history, []);
});

test('rejects turns with invalid roles', () => {
    assert.equal(ok({ query: 'hi', history: [{ role: 'system', content: 'bad' }] }), false);
    assert.equal(ok({ query: 'hi', history: [{ role: 'tool', content: 'bad' }] }), false);
});

test('rejects empty or non-string content', () => {
    assert.equal(ok({ query: 'hi', history: [{ role: 'user', content: '' }] }), false);
    assert.equal(ok({ query: 'hi', history: [{ role: 'user', content: 42 }] }), false);
});

test('rejects content exceeding MAX_CONTENT_LENGTH', () => {
    assert.equal(ok({ query: 'hi', history: [{ role: 'user', content: 'x'.repeat(2001) }] }), false);
});

test('rejects history exceeding MAX_TURNS', () => {
    const history = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    assert.equal(ok({ query: 'hi', history }), false);
});

test('strips unknown properties from message objects', () => {
    const result = val({ query: 'hi', history: [{ role: 'user', content: 'hello', secret: 'leak' }] });
    assert.deepEqual(result.history[0], { role: 'user', content: 'hello' });
});
