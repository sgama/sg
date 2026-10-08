import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import postcss from 'postcss';

test('production CSS retains theme-owned dark selectors and chat colors', async (t) => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    t.after(() => {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
    });
    const { default: config } = await import('../../postcss.config.js');
    const source = await readFile(new URL('../../assets/css/site.css', import.meta.url), 'utf8');
    const result = await postcss(config.plugins).process(source, { from: undefined });
    const rules = new Map();
    result.root.walkRules((rule) => {
        for (const selector of rule.selector.split(',').map((value) => value.trim())) {
            rules.set(selector, rule);
        }
    });
    const chat = rules.get('.dark .chat-widget');
    assert.ok(chat, 'Dark chat selector must survive production purging');
    const declarations = Object.fromEntries(chat.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]));
    assert.equal(declarations['--chat-bg'], 'rgb(var(--color-neutral-800))');
    assert.equal(declarations['--chat-panel'], 'rgb(var(--color-neutral-700))');
    assert.ok(rules.has('.dark .chat-cta'));
    assert.ok(rules.has('.dark .article-link--card'));
});
