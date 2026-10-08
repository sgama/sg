import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import { raw } from 'hast-util-raw';
import { toHast } from 'mdast-util-to-hast';
import { toMdast } from 'hast-util-to-mdast';
import { toString } from 'mdast-util-to-string';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify, { fences: true, bullet: '-', listItemIndent: 'one' });
const omitted = new Set(['script', 'style', 'svg', 'button', 'form', 'iframe', 'nav', 'header', 'footer', 'template']);
const htmlTags = new Set([
    'div',
    'section',
    'article',
    'main',
    'p',
    'span',
    'a',
    'img',
    'br',
    'hr',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'blockquote',
    'pre',
    'code',
    'strong',
    'em',
    'b',
    'i',
    'del',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    ...omitted,
]);

function walk(node, visit) {
    visit(node);
    for (const child of node.children ?? []) walk(child, visit);
}

function shortcodeTokens(content, protectedRanges) {
    const tokens = [];
    for (let start = content.indexOf('{{'); start !== -1; start = content.indexOf('{{', start + 2)) {
        const marker = content[start + 2];
        if (!['<', '%'].includes(marker) || protectedRanges.some(([from, to]) => start >= from && start < to)) continue;
        const close = marker === '<' ? '>}}' : '%}}';
        let quote = null;
        let end = start + 3;
        for (; end < content.length; end++) {
            const character = content[end];
            if (quote) {
                if (character === '\\') end++;
                else if (character === quote) quote = null;
            } else if (character === '"' || character === "'" || character === '`') quote = character;
            else if (content.startsWith(close, end)) break;
        }
        if (end >= content.length) throw new Error('Unclosed Hugo shortcode');
        const name = content
            .slice(start + 3, end)
            .trim()
            .match(/^\/?[\w-]+/)?.[0];
        if (!name) throw new Error('Invalid Hugo shortcode');
        tokens.push({ start, end: end + close.length, name });
        start = end;
    }
    return tokens;
}

function shortcodes(content) {
    const protectedRanges = [];
    walk(processor.parse(content), (node) => {
        if (node.type === 'code' || node.type === 'inlineCode') protectedRanges.push([node.position.start.offset, node.position.end.offset]);
    });
    const edits = [];
    let mermaid = null;
    for (const token of shortcodeTokens(content, protectedRanges)) {
        const name = token.name;
        if (name === 'mermaid') {
            if (mermaid) throw new Error('Nested Mermaid shortcode');
            mermaid = token;
        } else if (name === '/mermaid') {
            if (!mermaid) throw new Error('Unmatched Mermaid shortcode');
            const body = content.slice(mermaid.end, token.start).trim();
            const fences = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((item) => item[0].length + 1)));
            edits.push({ start: mermaid.start, end: token.end, text: `\n${fences}mermaid\n${body}\n${fences}\n` });
            mermaid = null;
        } else if (!mermaid) {
            edits.push({ start: token.start, end: token.end, text: '' });
        }
    }
    if (mermaid) throw new Error('Unclosed Mermaid shortcode');
    for (const edit of edits.reverse()) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
    return content;
}

function cleanHtml(node) {
    if (!node.children) return;
    node.children = node.children.filter(
        (child) => child.type !== 'comment' && !(child.type === 'element' && (omitted.has(child.tagName) || child.tagName === 'img')),
    );
    for (const child of node.children) cleanHtml(child);
}

function preserveLiteralTags(node) {
    if (!node.children) return;
    node.children = node.children.map((child) => {
        const tag = child.type === 'html' && child.value.match(/^<\/?([a-z][\w-]*)\b/i)?.[1].toLowerCase();
        if (tag && !htmlTags.has(tag)) return { type: 'text', value: child.value };
        preserveLiteralTags(child);
        return child;
    });
}

export function normalizedDocument(content, { rejectUnclosedComments = false } = {}) {
    if (rejectUnclosedComments) {
        const codeRanges = [];
        walk(processor.parse(content), (node) => {
            if (node.type === 'code' || node.type === 'inlineCode') codeRanges.push([node.position.start.offset, node.position.end.offset]);
        });
        for (const match of content.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
            if (!match[0].endsWith('-->') && !codeRanges.some(([start, end]) => match.index >= start && match.index < end)) {
                throw new Error('Unclosed authoring comment');
            }
        }
    }
    const prepared = shortcodes(content);
    const tree = processor.parse(prepared);
    preserveLiteralTags(tree);
    const html = raw(toHast(tree, { allowDangerousHtml: true }));
    cleanHtml(html);
    return toMdast(html);
}

export function ingestionText(content, options) {
    return processor.stringify(normalizedDocument(content, options)).trim();
}

export function sourceSections(content) {
    const tree = processor.parse(content);
    const sections = [];
    let heading = '';
    let children = [];
    const flush = () => {
        if (children.length) sections.push({ heading, text: processor.stringify({ type: 'root', children }).trim() });
        children = [];
    };
    for (const node of tree.children) {
        if (node.type === 'heading' && node.depth <= 2) {
            flush();
            heading = toString(node);
        }
        children.push(node);
    }
    flush();
    return sections;
}

export function hasEvidence(content) {
    return processor.parse(content).children.some((node) => node.type !== 'heading' && node.type !== 'definition');
}
