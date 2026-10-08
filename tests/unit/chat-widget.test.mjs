import test from 'node:test';
import assert from 'node:assert/strict';
import { setMaxListeners } from 'node:events';
import { apiHistory, createStore, readHistory, STORAGE_KEY, SESSION_OPEN_KEY } from '../../assets/js/chat/history.js';
import { createAnswerParser, streamAnswer } from '../../assets/js/chat/stream.js';
import { createChatScroller } from '../../assets/js/chat/scroll.js';
import { setImmediate } from 'node:timers/promises';

test('answer parser handles split CRLF events, usage, and completion', () => {
    const deltas = [];
    const parser = createAnswerParser((delta) => deltas.push(delta));
    parser.push('data:{"response":"Hel');
    parser.push('lo"}\r\n\r\ndata: {"usage":{"completion_tokens":1}}\n');
    parser.push('data: {"response":"!"}\ndata: [DONE]\ndata: {"response":"ignored"}\n');
    parser.flush();
    assert.deepEqual(deltas, ['Hello', '!']);
    assert.equal(parser.finished, true);
});

test('loading the widget preserves saved conversation history', async (t) => {
    const f = await widgetFixture(t, {
        history: [{ sender: 'bot', text: 'Saved answer' }],
    });
    assert.equal(f.local.has(STORAGE_KEY), true);
    f.widget.open();
    assert.equal(f.roles.transcript.children.length, 1);
    assert.equal(f.roles.transcript.children[0].dataset.rawText, 'Saved answer');
});

test('answer parser forwards metrics separately without including them in the answer', () => {
    const answers = [];
    const metrics = [];
    const parser = createAnswerParser(
        (text) => answers.push(text),
        (value) => metrics.push(value),
    );
    parser.push('data: {"response":"Answer"}\ndata: {"metrics":{"totalMs":123}}\ndata: [DONE]\n');
    assert.deepEqual(answers, ['Answer']);
    assert.deepEqual(metrics, [{ totalMs: 123 }]);
    for (const value of [null, [], 123, 'invalid']) {
        assert.throws(() => createAnswerParser(() => {}).push(`data: ${JSON.stringify({ metrics: value })}\n`), /metrics/);
    }
});

test('widget renders and persists response metrics outside answer text and API history', async (t) => {
    const f = await widgetFixture(t);
    const metrics = { totalMs: 1200, firstTokenMs: 300, estimatedLlmCostUsd: null, generationUsage: null };
    t.mock.method(
        globalThis,
        'fetch',
        async () => new Response(`data: {"response":"Answer"}\n\ndata: ${JSON.stringify({ metrics })}\n\ndata: [DONE]\n\n`),
    );
    f.widget.open();
    await f.submit('Question');
    const saved = JSON.parse(f.local.get(STORAGE_KEY));
    assert.equal(saved.at(-1).text, 'Answer');
    assert.deepEqual(saved.at(-1).metrics, metrics);
    const footer = f.roles.transcript.children.at(-1).children.at(-1);
    assert.ok(footer.classList.contains('response-metrics'));
    assert.match(footer.children[0].textContent, /🕧1.20s/);
    assert.match(footer.children[0].textContent, /Cost unavailable/);
    assert.equal(footer.children[1].children[0].textContent, 'Details');
    assert.match(footer.children[2].textContent, /AI answers may be inaccurate/);
    assert.deepEqual(apiHistory(saved, saved[0].text).at(-1), { role: 'assistant', content: 'Answer' });
});
test('answer parser reports provider errors and malformed answer fields', () => {
    for (const event of [{ error: 'Provider failed' }, { response: 42 }, null, [], 'invalid', 42]) {
        const parser = createAnswerParser(() => {});
        assert.throws(() => parser.push(`data: ${JSON.stringify(event)}\n`));
    }
});

test('stream cleanup preserves request errors and always releases the reader lock', async (t) => {
    const failure = new Error('Read failed');
    const cleanupFailure = new Error('Cancel failed');
    const warning = t.mock.method(console, 'warn', () => {});
    let released = false;
    await assert.rejects(
        streamAnswer('Question', {
            onUpdate() {},
            fetcher: async () => ({
                ok: true,
                body: {
                    getReader: () => ({
                        read: async () => {
                            throw failure;
                        },
                        cancel: async () => {
                            throw cleanupFailure;
                        },
                        releaseLock: () => {
                            released = true;
                        },
                    }),
                },
            }),
        }),
        (error) => error === failure,
    );
    assert.equal(released, true);
    assert.equal(warning.mock.callCount(), 1);
    assert.equal(warning.mock.calls[0].arguments[1], cleanupFailure);
});

test('disconnect resets launcher state and reconnect restores the session without duplicate handlers', async (t) => {
    const f = await widgetFixture(t);
    f.widget.open();
    assert.equal(f.roles.toggle.attributes.get('aria-expanded'), 'true');
    f.widget.disconnectedCallback();
    assert.equal(f.roles.toggle.attributes.get('aria-expanded'), 'false');
    assert.equal(f.roles.window.open, false);
    assert.equal(f.frames.size, 0);
    f.widget.connectedCallback();
    assert.equal(f.roles.window.open, true);
    assert.equal(f.roles.toggle.attributes.get('aria-expanded'), 'true');
    await f.submit('Question');
    assert.equal(f.roles.transcript.children.length, 3);
});

test('cleanup failure after a complete answer is reported and still releases the reader lock', async () => {
    const failure = new Error('Cancel failed');
    let released = false;
    let read = false;
    await assert.rejects(
        streamAnswer('Question', {
            onUpdate() {},
            fetcher: async () => ({
                ok: true,
                body: {
                    getReader: () => ({
                        read: async () => {
                            assert.equal(read, false);
                            read = true;
                            return { done: false, value: new TextEncoder().encode('data: {"response":"Answer"}\ndata: [DONE]\n') };
                        },
                        cancel: async () => {
                            throw failure;
                        },
                        releaseLock: () => {
                            released = true;
                        },
                    }),
                },
            }),
        }),
        (error) => error === failure,
    );
    assert.equal(released, true);
});

test('clear history requires confirmation and persists only the welcome message', async (t) => {
    const f = await widgetFixture(t);
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
    const f = await widgetFixture(t);
    f.widget.open();
    const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected request'));
    await f.submit(' ');
    f.valid(false);
    await f.submit('Invalid');
    const submit = t.mock.method(f.roles.form, 'requestSubmit', () => {});
    for (const extra of [{ shiftKey: true }, { isComposing: true }, { key: 'a' }, {}]) {
        const event = Object.assign(new Event('keydown', { cancelable: true }), {
            key: 'Enter',
            ...extra,
        });
        f.roles.input.dispatchEvent(event);
        assert.equal(event.defaultPrevented, Object.keys(extra).length === 0);
    }
    assert.equal(submit.mock.callCount(), 1);
    assert.equal(fetch.mock.callCount(), 0);
});

test('empty, interrupted, and unsuccessful responses fail explicitly', async () => {
    for (const [body, expected] of [
        ['data: [DONE]\n', /without an answer/],
        ['data: {"response":"Partial"}\n', /before completion/],
    ]) {
        await assert.rejects(
            streamAnswer('Question', {
                onUpdate() {},
                fetcher: async () => new Response(body),
            }),
            expected,
        );
    }
    await assert.rejects(
        streamAnswer('Question', {
            onUpdate() {},
            fetcher: async () => new Response('Unavailable', { status: 503 }),
        }),
        /503/,
    );
});

test('history validates stored messages and preserves the existing storage key', () => {
    const values = new Map();
    const store = createStore(
        () => ({
            getItem: (key) => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, value),
            removeItem: (key) => values.delete(key),
        }),
        { json: true },
    );
    assert.deepEqual(readHistory(store, 'Welcome'), [{ sender: 'bot', text: 'Welcome' }]);
    store.set(STORAGE_KEY, [{ sender: 'user', text: 'Question' }, { sender: 'bot', text: 'Answer' }, { sender: 'invalid', text: 'Ignored' }, null]);
    assert.deepEqual(readHistory(store, 'Welcome'), [
        { sender: 'user', text: 'Question' },
        { sender: 'bot', text: 'Answer' },
    ]);
    store.remove(STORAGE_KEY);
    assert.equal(values.size, 0);
});

test('API history excludes the welcome message and keeps a bounded recent window', () => {
    const welcome = 'Welcome';
    const messages = [
        { sender: 'bot', text: welcome },
        { sender: 'user', text: 'Old question' },
        { sender: 'bot', text: 'Old answer' },
        { sender: 'user', text: 'Recent question' },
        { sender: 'bot', text: 'Recent answer' },
    ];
    assert.deepEqual(apiHistory(messages, welcome), [
        { role: 'user', content: 'Old question' },
        { role: 'assistant', content: 'Old answer' },
        { role: 'user', content: 'Recent question' },
        { role: 'assistant', content: 'Recent answer' },
    ]);
    assert.deepEqual(apiHistory([...messages, { sender: 'user', text: 'x'.repeat(2001) }], welcome), [
        { role: 'user', content: 'Old question' },
        { role: 'assistant', content: 'Old answer' },
        { role: 'user', content: 'Recent question' },
        { role: 'assistant', content: 'Recent answer' },
    ]);
});

test('widget sends prior user and assistant turns with follow-up questions', async (t) => {
    const f = await widgetFixture(t);
    f.widget.open();
    await f.submit('What did Samson do last?');
    await f.submit('Most recently?');
    assert.deepEqual(f.fetchRequests, [
        { query: 'What did Samson do last?', history: [] },
        {
            query: 'Most recently?',
            history: [
                { role: 'user', content: 'What did Samson do last?' },
                { role: 'assistant', content: 'Answer' },
            ],
        },
    ]);
});

function scrollFixture() {
    const viewport = Object.assign(new EventTarget(), {
        scrollHeight: 1000,
        clientHeight: 200,
        scrollTop: 0,
    });
    const content = new EventTarget();
    const button = Object.assign(new EventTarget(), { hidden: true });
    const frames = new Map();
    let nextFrame = 0;
    let resize;
    let disconnected = false;
    let open = false;
    const events = new AbortController();
    const scroller = createChatScroller(viewport, content, button, {
        isOpen: () => open,
        signal: events.signal,
        requestFrame: (callback) => {
            frames.set(++nextFrame, callback);
            return nextFrame;
        },
        cancelFrame: (id) => frames.delete(id),
        Observer: class {
            constructor(callback) {
                resize = callback;
            }
            observe() {}
            disconnect() {
                disconnected = true;
            }
        },
    });
    return {
        viewport,
        button,
        scroller,
        resize: () => resize(),
        open: () => {
            open = true;
        },
        flush: () => {
            const callbacks = [...frames.values()];
            frames.clear();
            callbacks.forEach((callback) => callback());
        },
        dispose: () => {
            events.abort();
            scroller.destroy();
            assert.equal(disconnected, true);
            assert.equal(frames.size, 0);
        },
    };
}

test('invalid history warns and empty or invalid messages restore the welcome message', (t) => {
    const warning = t.mock.method(console, 'warn', () => {});
    const welcome = [{ sender: 'bot', text: 'Welcome' }];
    for (const value of [null, {}, 'invalid']) {
        assert.deepEqual(readHistory({ get: () => value }, 'Welcome'), welcome);
    }
    assert.equal(warning.mock.callCount(), 3);
    assert.ok(warning.mock.calls.every((call) => call.arguments[0] === 'Ignoring invalid chat history.'));
    for (const value of [[], [null, {}, { sender: 'user', text: ' ' }, { sender: 'user', text: 1 }, { sender: 'system', text: 'Invalid' }]]) {
        assert.deepEqual(readHistory({ get: () => value }, 'Welcome'), welcome);
    }
});

test('malformed JSON warns and returns the supplied fallback', (t) => {
    const warning = t.mock.method(console, 'warn', () => {});
    const fallback = [];
    const store = createStore(() => ({ getItem: () => '{' }), { json: true });
    assert.equal(store.get(STORAGE_KEY, fallback), fallback);
    assert.equal(warning.mock.callCount(), 1);
    assert.equal(warning.mock.calls[0].arguments[0], 'Chat storage could not be read.');
    assert.ok(warning.mock.calls[0].arguments[1] instanceof SyntaxError);
});

test('missing or incomplete templates log errors and leave opening inert', async (t) => {
    for (const [label, options] of [
        ['incomplete', { incomplete: true }],
        ['missing', { template: false }],
    ]) {
        await t.test(label, async (t) => {
            const f = await widgetFixture(t, options);
            f.widget.open();
            assert.equal(f.roles.window.open, undefined);
            assert.match(f.errors.mock.calls[0].arguments[0], new RegExp(label));
        });
    }
});

test('offline and HTTP failures show actionable messages and reset busy controls', async (t) => {
    const f = await widgetFixture(t);
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
    assert.ok(f.errors.mock.calls.every((call) => call.arguments[0] === 'Chat request failed.'));
});

test('opening history scrolls after layout; streaming and resizing keep following', () => {
    const fixture = scrollFixture();
    fixture.scroller.changed(true);
    fixture.flush();
    assert.equal(fixture.viewport.scrollTop, 0, 'closed dialog must not scroll');
    fixture.open();
    fixture.scroller.changed(true);
    fixture.flush();
    assert.equal(fixture.viewport.scrollTop, 1000);
    fixture.viewport.scrollHeight = 1200;
    fixture.resize();
    fixture.flush();
    assert.equal(fixture.viewport.scrollTop, 1200);
    fixture.dispose();
});

test('pending questions truncate, session restore opens and Escape restores opener focus', async (t) => {
    const f = await widgetFixture(t, { restore: true });
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

let index = 0;
async function widgetFixture(t, { template = true, incomplete = false, restore = false, history = [] } = {}) {
    let widget;
    t.after(() => widget?.disconnectedCallback());
    const classes = () => {
        const values = new Set();
        return {
            add: (...names) => names.forEach((name) => values.add(name)),
            remove: (name) => values.delete(name),
            contains: (name) => values.has(name),
            toggle: (name, enabled) => (enabled ? values.add(name) : values.delete(name)),
        };
    };
    const element = () =>
        Object.assign(new EventTarget(), {
            classList: classes(),
            dataset: {},
            textContent: '',
            value: '',
            maxLength: 20,
            attributes: new Map(),
            children: [],
            setAttribute(key, value) {
                this.attributes.set(key, value);
            },
            querySelectorAll() {
                return [];
            },
            focus() {
                this.focused = true;
            },
            append(...children) {
                this.children.push(...children);
            },
            replaceChildren(...children) {
                this.children = children;
            },
        });
    const roles = Object.fromEntries(
        ['toggle', 'window', 'close', 'clear', 'form', 'input', 'send', 'stop', 'messages', 'transcript', 'latest', 'status'].map((role) => [
            role,
            element(),
        ]),
    );
    roles.window.show = () => {
        roles.window.open = true;
    };
    roles.window.close = () => {
        roles.window.open = false;
        roles.window.dispatchEvent(new Event('close'));
    };
    let valid = true;
    roles.form.reportValidity = () => valid;
    roles.form.requestSubmit = () => roles.form.dispatchEvent(new Event('submit', { cancelable: true }));
    const local = new Map(history.length ? [[STORAGE_KEY, JSON.stringify(history)]] : []);
    const session = new Map(restore ? [[SESSION_OPEN_KEY, 'true']] : []);
    const storage = (values) => ({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
    });
    const reads = t.mock.fn(storage(local).getItem);
    let observed = 0;
    const frames = new Map();
    let frame = 0;
    let Widget;
    let hydrated = false;
    let confirmed = true;
    const fetchRequests = [];
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
            append() {
                hydrated = true;
            }
        },
        customElements: {
            get: () => undefined,
            define: (_, constructor) => {
                Widget = constructor;
            },
        },
        document: {
            body: element(),
            activeElement: opener,
            createElement: element,
            getElementById: () => (template ? { content: { cloneNode: () => ({}) } } : null),
        },
        window: { confirm: () => confirmed },
        navigator: { onLine: true },
        localStorage: { ...storage(local), getItem: reads },
        sessionStorage: storage(session),
        requestAnimationFrame: (callback) => {
            frames.set(++frame, callback);
            return frame;
        },
        cancelAnimationFrame: (id) => frames.delete(id),
        ResizeObserver: class {
            observe() {
                observed++;
            }
            disconnect() {}
        },
        CustomEvent: class extends Event {},
        AbortController: class extends NativeAbortController {
            constructor() {
                super();
                setMaxListeners(0, this.signal);
            }
        },
        fetch: async (_url, init) => {
            fetchRequests.push(JSON.parse(init.body));
            return new Response('data: {"response":"Answer"}\n\ndata: [DONE]\n\n');
        },
    };
    for (const [name, value] of Object.entries(globals)) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        t.after(() => (descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]));
    }
    const errors = t.mock.method(console, 'error', () => {});
    const warnings = t.mock.method(console, 'warn', () => {});
    await import(`../../assets/js/ai-chat-widget.js?lifecycle=${index++}`);
    widget = new Widget();
    widget.connectedCallback();
    await setImmediate();
    return {
        widget,
        roles,
        local,
        session,
        fetchRequests,
        opener,
        frames,
        errors,
        reads,
        warnings,
        observed: () => observed,
        valid: (value) => {
            valid = value;
        },
        confirm: (value) => {
            confirmed = value;
        },
        flush: () => {
            const callbacks = [...frames.values()];
            frames.clear();
            callbacks.forEach((fn) => fn());
        },
        async submit(text) {
            roles.input.value = text;
            roles.form.requestSubmit();
            await setImmediate();
        },
    };
}

test('plain and JSON stores round-trip values and remove keys', () => {
    for (const json of [false, true]) {
        const values = new Map();
        const store = createStore(
            () => ({
                getItem: (key) => values.get(key) ?? null,
                setItem: (key, value) => values.set(key, value),
                removeItem: (key) => values.delete(key),
            }),
            { json },
        );
        const value = json ? [{ sender: 'user', text: 'Hello' }] : 'true';
        assert.equal(store.get('missing', 'fallback'), 'fallback');
        store.set('key', value);
        assert.deepEqual(store.get('key'), value);
        store.remove('key');
        assert.equal(values.size, 0);
    }
});

test('reading older messages pauses follow; latest button or sending resumes it', () => {
    const fixture = scrollFixture();
    fixture.open();
    fixture.scroller.changed(true);
    fixture.flush();
    fixture.viewport.scrollTop = 100;
    fixture.viewport.dispatchEvent(new Event('scroll'));
    assert.equal(fixture.button.hidden, false);
    fixture.viewport.scrollHeight = 1400;
    fixture.scroller.changed();
    fixture.resize();
    fixture.flush();
    assert.equal(fixture.viewport.scrollTop, 100);
    fixture.button.dispatchEvent(new Event('click'));
    fixture.flush();
    assert.equal(fixture.viewport.scrollTop, 1400);
    assert.equal(fixture.button.hidden, true);
    fixture.viewport.scrollTop = 200;
    fixture.viewport.dispatchEvent(new Event('scroll'));
    fixture.scroller.changed(true);
    fixture.flush();
    assert.equal(fixture.viewport.scrollTop, 1400);
    fixture.dispose();
});

test('stop aborts streaming, preserves partial output and prevents late completion', async (t) => {
    const f = await widgetFixture(t);
    f.widget.open();
    let controller;
    let signal;
    t.mock.method(globalThis, 'fetch', async (_, options) => {
        signal = options.signal;
        return new Response(
            new ReadableStream({
                start(value) {
                    controller = value;
                    value.enqueue(new TextEncoder().encode('data: {"response":"Partial"}\n\n'));
                    signal.addEventListener('abort', () => value.error(signal.reason), {
                        once: true,
                    });
                },
            }),
        );
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

test('storage access and operation failures warn explicitly without breaking the widget', (t) => {
    const warning = t.mock.method(console, 'warn', () => {});
    const failure = new Error('Storage blocked');
    for (const storage of [
        () => {
            throw failure;
        },
        () => ({
            getItem() {
                throw failure;
            },
            setItem() {
                throw failure;
            },
            removeItem() {
                throw failure;
            },
        }),
    ]) {
        const store = createStore(storage);
        assert.equal(store.get('key', 'fallback'), 'fallback');
        store.set('key', 'value');
        store.remove('key');
    }
    assert.equal(warning.mock.callCount(), 6);
    assert.deepEqual(
        warning.mock.calls.map((call) => call.arguments[0]),
        [
            'Chat storage could not be read.',
            'Chat history could not be saved on this device.',
            'Chat storage could not be cleared.',
            'Chat storage could not be read.',
            'Chat history could not be saved on this device.',
            'Chat storage could not be cleared.',
        ],
    );
    assert.ok(warning.mock.calls.every((call) => call.arguments[1] === failure));
});

test('stream reader decodes fragmented UTF-8 and posts the query and history API contract', async () => {
    const encoded = new TextEncoder().encode('data: {"response":"Hello 🌍"}\n\ndata: [DONE]\n\n');
    const updates = [];
    const answer = await streamAnswer('Question', {
        signal: new AbortController().signal,
        onUpdate: (value) => updates.push(value),
        fetcher: async (url, options) => {
            assert.equal(url, '/api/chat');
            assert.deepEqual(JSON.parse(options.body), { query: 'Question', history: [] });
            return new Response(
                new ReadableStream({
                    start(controller) {
                        for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
                        controller.close();
                    },
                }),
            );
        },
    });
    assert.equal(answer, 'Hello 🌍');
    assert.equal(updates.at(-1), answer);
});

test('successful submissions persist answers and restore idle state', async (t) => {
    const f = await widgetFixture(t);
    f.widget.open();
    await f.submit(' Question ');
    const history = JSON.parse(f.local.get(STORAGE_KEY));
    assert.deepEqual(history.slice(1), [
        { sender: 'user', text: 'Question' },
        { sender: 'bot', text: 'Answer' },
    ]);
    assert.equal(f.roles.status.textContent, 'Response complete.');
    assert.equal(f.roles.transcript.attributes.get('aria-busy'), 'false');
    f.roles.close.dispatchEvent(new Event('click'));
    assert.equal(f.roles.window.open, false);
    f.widget.toggle();
    assert.equal(f.roles.window.open, true);
    f.widget.toggle();
    assert.equal(f.roles.window.open, false);
});

test('widget defers history reads and transcript rendering until first open', async (t) => {
    const f = await widgetFixture(t, { history: [{ sender: 'bot', text: 'Saved answer' }] });
    assert.equal(f.reads.mock.callCount(), 0);
    assert.equal(f.roles.transcript.children.length, 0);
    assert.equal(f.observed(), 0);
    f.widget.open();
    assert.equal(f.reads.mock.callCount(), 1);
    assert.equal(f.roles.transcript.children.length, 1);
    assert.equal(f.observed(), 2);
    f.widget.close();
    f.widget.open();
    assert.equal(f.reads.mock.callCount(), 1);
    f.widget.disconnectedCallback();
    f.widget.connectedCallback();
    f.widget.open();
    assert.equal(f.reads.mock.callCount(), 2);
    assert.equal(f.roles.transcript.children.length, 1, 'reconnect must replace rather than duplicate messages');
    await setImmediate();
    assert.equal(f.warnings.mock.callCount(), 1);
    assert.match(f.warnings.mock.calls[0].arguments[0], /displaying plain text/);
});
