import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMessageRenderer } from '../../assets/js/chat/render.js';

function element() {
    const link = {};
    return {
        dataset: {},
        classList: { toggle() {} },
        querySelectorAll: (selector) => (selector === 'a' ? [link] : []),
        link,
    };
}

test('renderer loads once, sanitizes parsed bot markdown and keeps user messages as text', async () => {
    let loads = 0;
    const renderer = createMessageRenderer({
        loadModules: async () => {
            loads++;
            return [
                {
                    marked: {
                        parse(text, options) {
                            assert.deepEqual(options, { gfm: true, breaks: true });
                            return `<p>${text}</p>`;
                        },
                    },
                },
                {
                    default: {
                        sanitize: (html, options) => {
                            assert.ok(!options.ALLOWED_TAGS.includes('button'));
                            assert.ok(!options.ALLOWED_TAGS.includes('svg'));
                            assert.ok(!options.ALLOWED_TAGS.includes('section'));
                            assert.deepEqual(options.FORBID_ATTR, ['style', 'id']);
                            return html.replace('<script>bad</script>', '');
                        },
                    },
                },
            ];
        },
    });
    const message = element();
    renderer.write(message, '<b>plain</b>', 'bot');
    assert.equal(message.textContent, '<b>plain</b>');
    assert.equal(renderer.ready, false);
    const first = renderer.load();
    assert.equal(first, renderer.load());
    await first;
    await renderer.load();
    assert.equal(loads, 1);
    assert.equal(renderer.ready, true);
    renderer.write(message, 'Answer<script>bad</script>', 'bot');
    assert.equal(message.innerHTML, '<p>Answer</p>');
    assert.equal(message.dataset.rawText, 'Answer<script>bad</script>');
    assert.deepEqual(message.link, { rel: 'noopener noreferrer', target: '_blank' });
    renderer.write(message, '<b>Question</b>', 'user');
    assert.equal(message.textContent, '<b>Question</b>');
    renderer.write(message, '', 'bot');
    assert.equal(message.textContent, 'Thinking…');
});

test('renderer removes website classes while preserving code language markers', async () => {
    const nodes = [
        {
            tagName: 'P',
            classList: ['intro__content'],
            removeAttribute: (name) => {
                assert.equal(name, 'class');
            },
        },
        {
            tagName: 'CODE',
            classList: ['chat-cta', 'language-mermaid'],
            setAttribute: (name, value) => {
                assert.equal(name, 'class');
                assert.equal(value, 'language-mermaid');
            },
        },
    ];
    let checked = false;
    const renderer = createMessageRenderer({
        loadModules: async () => [{ marked: { parse: (text) => text } }, { default: { sanitize: (text) => text } }],
    });
    await renderer.load();
    const message = element();
    message.querySelectorAll = (selector) => {
        if (selector === '[class]') {
            checked = true;
            return nodes;
        }
        return [];
    };
    renderer.write(message, 'Source', 'bot');
    assert.equal(checked, true);
});

test('failed or incomplete Markdown dependencies warn, retain plain text and allow retry', async () => {
    for (const failure of [() => Promise.reject(new Error('Unavailable')), () => Promise.resolve([{}, {}])]) {
        let attempts = 0;
        const warnings = [];
        const renderer = createMessageRenderer({
            loadModules: () => {
                attempts++;
                return attempts === 1
                    ? failure()
                    : Promise.resolve([{ marked: { parse: (text) => text } }, { default: { sanitize: (text) => text } }]);
            },
            warn: (...args) => warnings.push(args),
        });

        await renderer.load();
        assert.equal(renderer.ready, false);
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0][1] instanceof Error);
        const message = element();
        renderer.write(message, 'Answer', 'bot');
        assert.equal(message.textContent, 'Answer');
        await renderer.load();
        assert.equal(renderer.ready, true);
        assert.equal(attempts, 2);
    }
});

test('source diagrams load lazily, render once and sanitize SVG without interactive content', async () => {
    let loads = 0;
    let replacement;
    const code = {
        textContent: 'graph TD\nA --> B',
        ownerDocument: { createElement: () => ({ classList: { add() {} } }) },
        parentElement: {
            replaceWith: (node) => {
                replacement = node;
            },
        },
    };
    const source = { querySelectorAll: () => [code], contains: () => true };
    const renderer = createMessageRenderer({
        loadModules: async () => [
            { marked: { parse: (text) => text } },
            {
                default: {
                    sanitize: (text, options) => {
                        assert.deepEqual(options.USE_PROFILES, { svg: true, svgFilters: true });
                        assert.deepEqual(options.FORBID_TAGS, ['foreignObject', 'a']);
                        return text;
                    },
                },
            },
        ],
        loadMermaid: async () => {
            loads++;
            return {
                default: {
                    initialize: (options) => {
                        assert.equal(options.securityLevel, 'strict');
                        assert.equal(options.suppressErrorRendering, true);
                        assert.equal(options.flowchart.htmlLabels, false);
                    },
                    render: async (_id, text) => {
                        assert.equal(text, code.textContent);
                        return { svg: '<svg></svg>' };
                    },
                },
            };
        },
    });
    await renderer.load();
    assert.equal(loads, 0);
    await renderer.renderDiagrams(source);
    await renderer.renderDiagrams(source);
    assert.equal(loads, 1);
    assert.equal(replacement.innerHTML, '<svg></svg>');
});

test('failed source diagrams retain readable code and display an explicit explanation', async () => {
    const warnings = [];
    let note;
    const code = {
        ownerDocument: { createElement: () => ({}) },
        parentElement: {
            before: (node) => {
                note = node;
            },
        },
    };
    const renderer = createMessageRenderer({
        loadMermaid: async () => {
            throw new Error('Unavailable');
        },
        warn: (...args) => warnings.push(args),
    });
    await renderer.renderDiagrams({ querySelectorAll: () => [code], contains: () => true });
    assert.equal(warnings.length, 1);
    assert.match(note.textContent, /Diagram unavailable/);
});
