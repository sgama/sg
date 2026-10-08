import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizedDocument, ingestionText, sourceSections } from '../../scripts/lib/content-normalization.mjs';

test('normalization preserves nested lists, code, angle brackets and Markdown entities semantically', () => {
    const examples = [
        'Use List<T> for values.',
        '- First\n  - Nested\n\n    More text',
        '    indented code\n    <section>literal</section>',
        '`{{< figure src="x" >}}`',
        '````markdown\n```mermaid\nA --> B\n```\n````',
        'A &amp; B and <https://example.com> and <someone@example.com>.',
        '[Documentation](https://example.com "Title")',
        '| Tool | Purpose |\n| --- | --- |\n| Go | Services |',
    ];
    const shape = (node) => {
        const { position: _position, ...rest } = node;
        return { ...rest, ...(node.children ? { children: node.children.map(shape) } : {}) };
    };
    for (const input of examples) {
        assert.deepEqual(shape(normalizedDocument(ingestionText(input))), shape(normalizedDocument(input)), input);
    }
    assert.equal(
        normalizedDocument('Use List<T> for values.')
            .children[0].children.map((node) => node.value)
            .join(''),
        'Use List<T> for values.',
    );
    assert.equal(normalizedDocument('- First\n  - Nested').children[0].children[0].children[1].type, 'list');
    assert.equal(normalizedDocument('    code').children[0].type, 'code');
});

test('media removal understands balanced destinations and reference images', () => {
    assert.equal(ingestionText('![alt](image_(small).png)'), '');
    assert.equal(ingestionText('![alt][portrait]\n\n[portrait]: /portrait.webp'), '');
    assert.equal(ingestionText('Useful ![alt](x.png) prose'), 'Useful prose');
});

test('Hugo shortcodes are processed only outside literal code', () => {
    const content = '```html\n<!-- incomplete\n{{< mermaid >}}\n```\n\n`{{< figure >}}`';
    assert.equal(ingestionText(content, { rejectUnclosedComments: true }), content);
    assert.equal(ingestionText('{{% button %}}Useful text{{% /button %}}'), 'Useful text');
    assert.equal(ingestionText('{{< button label=">}}" >}}Body{{< /button >}}'), 'Body');
    assert.equal(ingestionText('{{< mermaid >}}\ngraph TD\nA --> B\n{{< /mermaid >}}'), '```mermaid\ngraph TD\nA --> B\n```');
    assert.throws(() => ingestionText('{{< mermaid >}}A --> B'), /Unclosed Mermaid/);
});

test('HTML content becomes Markdown structure, with controls removed', () => {
    const result = ingestionText(
        '<section><h2>Facts</h2><ul><li>First</li><li>Second</li></ul><p>Read <a href="/resume/">resume</a>.</p><button>Ask AI</button></section>',
    );
    assert.match(result, /## Facts/);
    assert.match(result, /- First\n- Second/);
    assert.match(result, /\[resume\]\(\/resume\/\)/);
    assert.doesNotMatch(result, /Ask AI|section|button/);
    assert.equal(ingestionText('Before <button>Ask AI</button> after'), 'Before after');
    assert.equal(ingestionText('See <a href="/resume/">resume</a>.'), 'See [resume](/resume/).');
    assert.equal(ingestionText('Some <strong>bold</strong> prose.'), 'Some **bold** prose.');
    assert.equal(ingestionText('Literal <code>example &amp; more</code>.'), 'Literal `example & more`.');
});

test('sections support Setext headings and retain lower-level headings with their parent', () => {
    assert.deepEqual(
        sourceSections('Title\n=====\n\nIntro\n\nDetails\n-------\n\n### Subheading\n\nBody').map((section) => section.heading),
        ['Title', 'Details'],
    );
    assert.match(sourceSections('## Details\n\n### Subheading\n\nBody')[0].text, /### Subheading/);
});
