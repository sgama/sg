/**
 * Unit tests for ChatRequestSchema (history validation)
 * Tests query and conversation history validation using Zod schema
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatRequestSchema } from '../../functions/_lib/schemas.js';
import { VALIDATION, buildHistory } from '../helpers/index.mjs';

const parse = (data) => ChatRequestSchema.safeParse(data);
const ok = (data) => parse(data).success;
const val = (data) => parse(data).data;

test('ChatRequestSchema', async (t) => {
  await t.test('Query validation', async (t) => {
    await t.test('rejects missing query', () => {
      assert.equal(ok({}), false);
    });

    await t.test('rejects empty query', () => {
      assert.equal(ok({ query: '' }), false);
    });

    await t.test('rejects whitespace-only query', () => {
      assert.equal(ok({ query: '   ' }), false);
    });

    await t.test('rejects query over MAX_QUERY_LENGTH (500 chars)', () => {
      assert.equal(ok({ query: 'x'.repeat(VALIDATION.MAX_QUERY_LENGTH + 1) }), false);
    });

    await t.test('accepts query at exactly MAX_QUERY_LENGTH', () => {
      assert.equal(ok({ query: 'x'.repeat(VALIDATION.MAX_QUERY_LENGTH) }), true);
    });

    await t.test('trims query whitespace', () => {
      assert.equal(val({ query: '  hi  ' }).query, 'hi');
    });
  });

  await t.test('History validation', async (t) => {
    await t.test('defaults history to empty array when omitted', () => {
      assert.deepEqual(val({ query: 'hi' }).history, []);
    });

    await t.test('rejects turns with invalid role "system"', () => {
      assert.equal(ok({
        query: 'hi',
        history: buildHistory({ role: 'system', content: 'bad' })
      }), false);
    });

    await t.test('rejects turns with invalid role "tool"', () => {
      assert.equal(ok({
        query: 'hi',
        history: buildHistory({ role: 'tool', content: 'bad' })
      }), false);
    });

    await t.test('rejects empty content', () => {
      assert.equal(ok({
        query: 'hi',
        history: buildHistory({ role: 'user', content: '' })
      }), false);
    });

    await t.test('rejects non-string content', () => {
      assert.equal(ok({
        query: 'hi',
        history: buildHistory({ role: 'user', content: 42 })
      }), false);
    });

    await t.test('rejects content exceeding MAX_CONTENT_LENGTH', () => {
      assert.equal(ok({
        query: 'hi',
        history: buildHistory({ role: 'user', content: 'x'.repeat(VALIDATION.MAX_CONTENT_LENGTH + 1) })
      }), false);
    });

    await t.test('rejects history exceeding MAX_TURNS', () => {
      const history = Array.from({ length: VALIDATION.MAX_TURNS + 1 }, (_, i) =>
        ({ role: 'user', content: `m${i}` })
      );
      assert.equal(ok({ query: 'hi', history }), false);
    });

    await t.test('strips unknown properties from message objects', () => {
      const result = val({
        query: 'hi',
        history: buildHistory({ role: 'user', content: 'hello', secret: 'leak' })
      });
      assert.deepEqual(result.history[0], { role: 'user', content: 'hello' });
    });
  });
});
