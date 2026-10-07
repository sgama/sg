import assert from 'node:assert/strict';
import { setMaxListeners } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { STORAGE_KEY, SESSION_OPEN_KEY } from '../../assets/js/chat/history.js';

let index = 0;
async function fixture(t, { template = true, incomplete = false, restore = false } = {}) {
    let widget;
    t.after(() => widget?.disconnectedCallback());
    const classes = () => {
        const values = new Set();
        return { add: (...names) => names.forEach(name => values.add(name)),
            remove: name => values.delete(name), contains: name => values.has(name),
            toggle: (name, enabled) => enabled ? values.add(name) : values.delete(name) };
    };
    const element = () => Object.assign(new EventTarget(), {
        classList: classes(), dataset: {}, textContent: '', value: '', maxLength: 20,
        attributes: new Map(), children: [],
        setAttribute(key, value) { this.attributes.set(key, value); },
        querySelectorAll() { return []; },
        focus() { this.focused = true; },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
    });
    const roles = Object.fromEntries(['toggle', 'window', 'close', 'clear', 'form', 'input',
        'send', 'stop', 'messages', 'transcript', 'latest', 'status'].map(role => [role, element()]));
    roles.window.show = () => { roles.window.open = true; };
    roles.window.close = () => {
        roles.window.open = false;
        roles.window.dispatchEvent(new Event('close'));
    };
    let valid = true;
    roles.form.reportValidity = () => valid;
    roles.form.requestSubmit = () => roles.form.dispatchEvent(new Event('submit', { cancelable: true }));
    const local = new Map();
    const session = new Map(restore ? [[SESSION_OPEN_KEY, 'true']] : []);
    const storage = values => ({ getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) });
    const frames = new Map();
    let frame = 0;
    let Widget;
    let hydrated = false;
    let confirmed = true;
    const opener = { isConnected: true, focus: t.mock.fn() };
    const NativeAbortController = globalThis.AbortController;
    const globals = {
        HTMLElement: class extends EventTarget {
            classList = classes();
            isConnected = true;
            querySelector(selector) {
                const role = selector.match(/data-role="([^"]+)"/)[1];
                if (incomplete && role === 'send') return null;
                if (role === 'window' && !hydrated) return null;
                return roles[role];
            }
            append() { hydrated = true; }
        },
        customElements: { get: () => undefined, define: (_, constructor) => { Widget = constructor; } },
        document: { body: element(), activeElement: opener, createElement: element,
            getElementById: () => template ? { content: { cloneNode: () => ({}) } } : null },
        window: { confirm: () => confirmed },
        navigator: { onLine: true },
        localStorage: storage(local), sessionStorage: storage(session),
        requestAnimationFrame: callback => { frames.set(++frame, callback); return frame; },
        cancelAnimationFrame: id => frames.delete(id),
        ResizeObserver: class { observe() {} disconnect() {} },
        CustomEvent: class extends Event {},
        AbortController: class extends NativeAbortController {
            constructor() { super(); setMaxListeners(0, this.signal); }
        },
        fetch: async () => new Response('data: {"response":"Answer"}\n\ndata: [DONE]\n\n'),
    };
    for (const [name, value] of Object.entries(globals)) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
    }
    const errors = t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
    await import(`../../assets/js/ai-chat-widget.js?lifecycle=${index++}`);
    widget = new Widget();
    widget.connectedCallback();
    await setImmediate();
    return { widget, roles, local, session, opener, frames, errors,
        valid: value => { valid = value; }, confirm: value => { confirmed = value; },
        flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); },
        async submit(text) { roles.input.value = text; roles.form.requestSubmit(); await setImmediate(); } };
}

test('clear history requires confirmation and persists only the welcome message', async (t) => {
    const f = await fixture(t);
    f.widget.open();
    await f.submit('Question');
    assert.equal(JSON.parse(f.local.get(STORAGE_KEY)).length, 3);
    f.confirm(false);
    f.roles.clear.dispatchEvent(new Event('click'));
    assert.equal(JSON.parse(f.local.get(STORAGE_KEY)).length, 3);
    f.confirm(true);
    f.roles.clear.dispatchEvent(new Event('click'));
    assert.equal(JSON.parse(f.local.get(STORAGE_KEY)).length, 1);
    assert.equal(f.roles.transcript.children.length, 1);
    assert.equal(f.roles.status.textContent, 'Chat history cleared.');
});

test('empty and invalid submissions do not fetch; Enter respects shift and composition', async (t) => {
    const f = await fixture(t);
    f.widget.open();
    const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected request'));
    await f.submit(' ');
    f.valid(false);
    await f.submit('Invalid');
    const submit = t.mock.method(f.roles.form, 'requestSubmit', () => {});
    for (const extra of [{ shiftKey: true }, { isComposing: true }, { key: 'a' }, {}]) {
        const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Enter', ...extra });
        f.roles.input.dispatchEvent(event);
        assert.equal(event.defaultPrevented, Object.keys(extra).length === 0);
    }
    assert.equal(submit.mock.callCount(), 1);
    assert.equal(fetch.mock.callCount(), 0);
});

test('missing or incomplete templates log errors and leave opening inert', async (t) => {
    for (const [label, options] of [['incomplete', { incomplete: true }], ['missing', { template: false }]]) {
        await t.test(label, async (t) => {
            const f = await fixture(t, options);
            f.widget.open();
            assert.equal(f.roles.window.open, undefined);
            assert.match(f.errors.mock.calls[0].arguments[0], new RegExp(label));
        });
    }
});

test('offline and HTTP failures show actionable messages and reset busy controls', async (t) => {
    const f = await fixture(t);
    f.widget.open();
    navigator.onLine = false;
    await f.submit('Question');
    assert.match(f.roles.status.textContent, /offline/);
    navigator.onLine = true;
    t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
    await f.submit('Again');
    assert.match(f.roles.status.textContent, /could not be completed/);
    assert.equal(f.roles.send.disabled, false);
    assert.equal(f.roles.stop.hidden, true);
    assert.equal(f.errors.mock.callCount(), 2);
    assert.ok(f.errors.mock.calls.every(call => call.arguments[0] === 'Chat request failed.'));
});

test('pending questions truncate, session restore opens and Escape restores opener focus', async (t) => {
    const f = await fixture(t, { restore: true });
    assert.equal(f.roles.window.open, true);
    f.widget.connectedCallback();
    f.widget.setPendingQuestion('x'.repeat(100));
    assert.equal(f.roles.input.value.length, 20);
    f.flush();
    assert.equal(f.roles.input.focused, true);
    const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    f.roles.window.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(f.roles.window.open, false);
    assert.equal(f.session.has(SESSION_OPEN_KEY), false);
    assert.equal(f.opener.focus.mock.callCount(), 1);
    f.widget.close();
    f.widget.setPendingQuestion('Queued');
    f.roles.toggle.dispatchEvent(new Event('click'));
    assert.equal(f.roles.input.value, 'Queued');
    f.roles.window.dispatchEvent(new Event('close'));
    assert.equal(f.roles.window.open, true);
    f.roles.window.dispatchEvent(new Event('cancel', { cancelable: true }));
    assert.equal(f.roles.window.open, false);
});

test('stop aborts streaming, preserves partial output and prevents late completion', async (t) => {
    const f = await fixture(t);
    f.widget.open();
    let controller;
    let signal;
    t.mock.method(globalThis, 'fetch', async (_, options) => {
        signal = options.signal;
        return new Response(new ReadableStream({ start(value) {
            controller = value;
            value.enqueue(new TextEncoder().encode('data: {"response":"Partial"}\n\n'));
            signal.addEventListener('abort', () => value.error(signal.reason), { once: true });
        } }));
    });
    await f.submit('Question');
    assert.equal(f.roles.send.disabled, true);
    f.flush();
    assert.equal(f.roles.transcript.children.at(-1).textContent, 'Partial');
    const count = f.roles.transcript.children.length;
    await f.submit('Duplicate');
    assert.equal(f.roles.transcript.children.length, count);
    f.roles.stop.dispatchEvent(new Event('click'));
    await setImmediate();
    assert.equal(signal.aborted, true);
    assert.match(f.roles.transcript.children.at(-1).textContent, /Partial.*\n\n\(Response stopped\.\)/);
    assert.equal(f.roles.status.textContent, 'Response stopped.');
    assert.equal(f.roles.send.disabled, false);
    assert.equal(f.errors.mock.callCount(), 0);
    assert.throws(() => controller.close());
});

test('successful submissions persist answers and restore idle state', async (t) => {
    const f = await fixture(t);
    f.widget.open();
    await f.submit(' Question ');
    const history = JSON.parse(f.local.get(STORAGE_KEY));
    assert.deepEqual(history.slice(1), [{ sender: 'user', text: 'Question' }, { sender: 'bot', text: 'Answer' }]);
    assert.equal(f.roles.status.textContent, 'Response complete.');
    assert.equal(f.roles.transcript.attributes.get('aria-busy'), 'false');
    f.roles.close.dispatchEvent(new Event('click'));
    assert.equal(f.roles.window.open, false);
    f.widget.toggle();
    assert.equal(f.roles.window.open, true);
    f.widget.toggle();
    assert.equal(f.roles.window.open, false);
});
