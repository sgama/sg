import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const url = new URL('../../assets/js/background-blur.js', import.meta.url);
const source = await readFile(url, 'utf8');

function fixture({ id = 'background', disabled = false, missing = false, divisor } = {}) {
    const attributes = new Map();
    const element = { style: {}, setAttribute: (key, value) => attributes.set(key, value),
        removeAttribute: key => attributes.delete(key) };
    const listeners = new Map();
    const frames = [];
    const errors = [];
    let observer;
    let sentinel;
    const window = {
        pageYOffset: 0,
        addEventListener: (event, fn, options) => {
            assert.equal(options.passive, true);
            listeners.set(event, fn);
        },
        removeEventListener: event => listeners.delete(event),
    };
    const document = {
        documentElement: { scrollTop: 0 },
        body: { scrollTop: 0, prepend: value => { sentinel = value; } },
        getElementById: () => missing ? null : element,
        createElement: () => ({ style: {} }),
        querySelectorAll: () => [{ getAttribute: name =>
            name === 'data-blur-id' ? id : divisor }],
    };
    runInNewContext(source, {
        document, window,
        localStorage: { getItem: () => JSON.stringify({ disableBlur: disabled }) },
        console: { error: message => errors.push(message) },
        requestAnimationFrame: fn => frames.push(fn),
        IntersectionObserver: class {
            constructor(callback) { observer = callback; }
            observe(value) { assert.equal(value, sentinel); }
        },
    }, { filename: fileURLToPath(url) });
    return { element, attributes, listeners, frames, errors, window, document,
        intersect: value => observer([{ isIntersecting: value }]),
        flush: () => frames.splice(0).forEach(fn => fn()) };
}

test('disabled backgrounds hide while disabled menu backgrounds remain visible', () => {
    const background = fixture({ disabled: true });
    assert.equal(background.element.style.display, 'none');
    assert.equal(background.element.style.opacity, '0');
    assert.equal(background.attributes.get('aria-hidden'), 'true');
    background.intersect(true);
    assert.equal(background.frames.length, 0);
    background.intersect(false);
    assert.equal(background.element.style.opacity, '0');
    const menu = fixture({ id: 'menu-blur', disabled: true });
    assert.equal(menu.element.style.display, '');
    menu.intersect(false);
    assert.equal(menu.element.style.opacity, '1');
    menu.intersect(true);
    menu.flush();
    assert.equal(menu.element.style.opacity, 0);
});

test('missing targets are ignored and absent IDs report an error', () => {
    assert.equal(fixture({ missing: true }).listeners.size, 0);
    assert.deepEqual(fixture({ id: null }).errors, ['data-blur-id is null']);
});

test('scroll updates are frame-coalesced, clamped and stopped outside the sentinel', () => {
    const f = fixture({ divisor: '100' });
    assert.equal(f.attributes.get('role'), 'presentation');
    assert.equal(f.attributes.get('tabindex'), '-1');
    assert.ok(!f.attributes.has('aria-hidden'));
    f.intersect(true);
    f.listeners.get('scroll')();
    assert.equal(f.frames.length, 1);
    f.window.pageYOffset = 50;
    f.flush();
    assert.equal(f.element.style.opacity, 0.5);
    f.window.pageYOffset = 200;
    f.listeners.get('scroll')();
    f.flush();
    assert.equal(f.element.style.opacity, '1');
    f.window.pageYOffset = 0;
    f.document.documentElement.scrollTop = 75;
    f.listeners.get('scroll')();
    f.flush();
    assert.equal(f.element.style.opacity, 0.75);
    f.document.documentElement.scrollTop = 0;
    f.document.body.scrollTop = 25;
    f.listeners.get('scroll')();
    f.flush();
    assert.equal(f.element.style.opacity, 0.25);
    f.intersect(false);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.element.style.opacity, '1');
});
