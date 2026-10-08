import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMessageRenderer } from '../../assets/js/chat/render.js';

function element() {
    const link = {};
    return {
        dataset: {},
        classList: { toggle() {} },
        querySelectorAll: () => [link],
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
                { default: { sanitize: (html) => html.replace('<script>bad</script>', '') } },
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
