import test from "node:test";
import assert from "node:assert/strict";
import { createStore, readHistory, STORAGE_KEY } from "../../assets/js/chat/history.js";
import { createAnswerParser, streamAnswer } from "../../assets/js/chat/stream.js";
import { createChatScroller } from "../../assets/js/chat/scroll.js";

test("history validates stored messages and preserves the existing storage key", () => {
    const values = new Map();
    const store = createStore(() => ({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
    }), { json: true });
    assert.deepEqual(readHistory(store, "Welcome"), [{ sender: "bot", text: "Welcome" }]);
    store.set(STORAGE_KEY, [
        { sender: "user", text: "Question" },
        { sender: "bot", text: "Answer" },
        { sender: "invalid", text: "Ignored" },
        null,
    ]);
    assert.deepEqual(readHistory(store, "Welcome"), [
        { sender: "user", text: "Question" },
        { sender: "bot", text: "Answer" },
    ]);
    store.remove(STORAGE_KEY);
    assert.equal(values.size, 0);
});

test("answer parser handles split CRLF events, usage, and completion", () => {
    const deltas = [];
    const parser = createAnswerParser((delta) => deltas.push(delta));
    parser.push('data:{"response":"Hel');
    parser.push('lo"}\r\n\r\ndata: {"usage":{"completion_tokens":1}}\n');
    parser.push('data: {"response":"!"}\ndata: [DONE]\ndata: {"response":"ignored"}\n');
    parser.flush();
    assert.deepEqual(deltas, ["Hello", "!"]);
    assert.equal(parser.finished, true);
});

test("answer parser reports provider errors and malformed answer fields", () => {
    for (const event of [{ error: "Provider failed" }, { response: 42 }]) {
        const parser = createAnswerParser(() => {});
        assert.throws(() => parser.push(`data: ${JSON.stringify(event)}\n`));
    }
});

test("stream reader decodes fragmented UTF-8 and posts the query-only API contract", async () => {
    const encoded = new TextEncoder().encode('data: {"response":"Hello 🌍"}\n\ndata: [DONE]\n\n');
    const updates = [];
    const answer = await streamAnswer("Question", {
        signal: new AbortController().signal,
        onUpdate: (value) => updates.push(value),
        fetcher: async (url, options) => {
            assert.equal(url, "/api/chat");
            assert.deepEqual(JSON.parse(options.body), { query: "Question" });
            return new Response(new ReadableStream({
                start(controller) {
                    for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
                    controller.close();
                },
            }));
        },
    });
    assert.equal(answer, "Hello 🌍");
    assert.equal(updates.at(-1), answer);
});

test("empty, interrupted, and unsuccessful responses fail explicitly", async () => {
    for (const [body, expected] of [
        ["data: [DONE]\n", /without an answer/],
        ['data: {"response":"Partial"}\n', /before completion/],
    ]) {
        await assert.rejects(streamAnswer("Question", {
            onUpdate() {},
            fetcher: async () => new Response(body),
        }), expected);
    }
    await assert.rejects(streamAnswer("Question", {
        onUpdate() {},
        fetcher: async () => new Response("Unavailable", { status: 503 }),
    }), /503/);
});

function scrollFixture() {
    const viewport = Object.assign(new EventTarget(), { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
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
        requestFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
        cancelFrame: (id) => frames.delete(id),
        Observer: class {
            constructor(callback) { resize = callback; }
            observe() {}
            disconnect() { disconnected = true; }
        },
    });
    return {
        viewport, button, scroller, resize: () => resize(),
        open: () => { open = true; },
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

test("opening history scrolls after layout; streaming and resizing keep following", () => {
    const fixture = scrollFixture();
    fixture.scroller.changed(true);
    fixture.flush();
    assert.equal(fixture.viewport.scrollTop, 0, "closed dialog must not scroll");
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

test("reading older messages pauses follow; latest button or sending resumes it", () => {
    const fixture = scrollFixture();
    fixture.open();
    fixture.scroller.changed(true);
    fixture.flush();
    fixture.viewport.scrollTop = 100;
    fixture.viewport.dispatchEvent(new Event("scroll"));
    assert.equal(fixture.button.hidden, false);
    fixture.viewport.scrollHeight = 1400;
    fixture.scroller.changed();
    fixture.resize();
    fixture.flush();
    assert.equal(fixture.viewport.scrollTop, 100);
    fixture.button.dispatchEvent(new Event("click"));
    fixture.flush();
    assert.equal(fixture.viewport.scrollTop, 1400);
    assert.equal(fixture.button.hidden, true);
    fixture.viewport.scrollTop = 200;
    fixture.viewport.dispatchEvent(new Event("scroll"));
    fixture.scroller.changed(true);
    fixture.flush();
    assert.equal(fixture.viewport.scrollTop, 1400);
    fixture.dispose();
});
