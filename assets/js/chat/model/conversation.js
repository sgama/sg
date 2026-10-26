import { apiHistory, MAX_SAVED_MESSAGES, readHistory, STORAGE_KEY } from './history.js';
import { streamAnswer as fetchAnswer } from './stream.js';
import { formatResponseMetrics } from './metrics.js';

const STAGE_LABELS = {
    rewrite: '🧠 Understanding your follow-up…',
    embedding: '🧩 Preparing source search…',
    search: '🔎 Finding sources…',
    generation: '✍️ Writing answer…',
};

/** Human label for a server progress stage; undefined for unknown stages. */
function stageLabel(stage) {
    return STAGE_LABELS[stage];
}

/** Explanation shown when a request fails, depending on connectivity. */
function failureMessage(online) {
    return online ? 'The response could not be completed. Please try again.' : 'You appear to be offline. Check your connection and try again.';
}

export const WELCOME_MESSAGE = "Hello! I'm an AI assistant using information from this portfolio. Ask me about my projects or background.";

/**
 * Conversation and request state for the assistant. This module never touches the DOM:
 * a view subscribes to its events and renders them. Every host dependency is injected.
 *
 * Events:
 *   message:add     { message }      a message was appended to the conversation
 *   message:update  { message }      a message's text changed
 *   history:reset   {}               the whole conversation was replaced
 *   busy            { busy }         a request started or finished
 *   stage           { request }      the server reported a new progress stage (request is a snapshot)
 *   answer          { request }      streamed answer text advanced
 *   status          { text }         a user-facing status line changed
 *
 * @typedef {{ get(key: string, fallback?: any): any, set(key: string, value: any): void, remove(key: string): void }} Store
 * @param {{ storage: Store, streamAnswer?: typeof fetchAnswer, isOnline?: () => boolean, now?: () => number, log?: Pick<Console, 'error'> }} options
 */
export function createConversation({
    storage,
    streamAnswer = fetchAnswer,
    isOnline = () => globalThis.navigator?.onLine !== false,
    now = () => performance.now(),
    log = console,
}) {
    const listeners = new Set();
    const retries = new WeakMap();
    let messages = [];
    let request = null;

    // A failing view must not corrupt controller state, so each listener is isolated.
    const emit = (event) => {
        for (const listener of listeners) {
            try {
                listener(event);
            } catch (error) {
                log.error('Chat view failed to render an update.', error);
            }
        }
    };
    let nextId = 0;
    // Views receive snapshots, never the live request (which holds the AbortController). `message` is
    // shared by reference so the view can map it to its element.
    const snapshot = (active) => ({
        id: active.id,
        message: active.message,
        query: active.query,
        stage: active.stage,
        answer: active.answer,
        elapsedMs: now() - active.started,
    });
    const persist = () => storage.set(STORAGE_KEY, messages.filter((message) => message.text.trim()).slice(-MAX_SAVED_MESSAGES));
    const add = (message) => {
        messages.push(message);
        emit({ type: 'message:add', message });
    };

    // Ignores stale callbacks: only the request that is still current may change state.
    const isCurrent = (active) => request === active;

    function finish(active, text, status) {
        if (!isCurrent(active)) return;
        active.message.text = text;
        persist();
        request = null;
        emit({ type: 'busy', busy: false });
        emit({ type: 'message:update', message: active.message });
        emit({ type: 'status', text: status });
    }

    function onStage(active, stage) {
        if (!isCurrent(active)) return;
        active.stage = stageLabel(stage);
        emit({ type: 'stage', request: snapshot(active) });
    }

    function onEvidence(active, value) {
        // Stored as received; the view filters evidence to public sources at render time.
        if (isCurrent(active)) active.message.evidence = value;
    }

    function onMetrics(active, metrics) {
        if (!isCurrent(active)) return;
        if (!formatResponseMetrics(metrics)) throw new Error('Invalid response metrics');
        active.message.metrics = metrics;
    }

    function onAnswer(active, answer) {
        if (!isCurrent(active)) return;
        active.answer = answer;
        emit({ type: 'answer', request: snapshot(active) });
    }

    async function run(active) {
        try {
            if (!isOnline()) throw new Error('Offline');
            const answer = await streamAnswer(active.query, {
                history: active.history,
                signal: active.controller.signal,
                onProgress: (stage) => onStage(active, stage),
                onEvidence: (value) => onEvidence(active, value),
                onMetrics: (metrics) => onMetrics(active, metrics),
                onUpdate: (text) => onAnswer(active, text),
            });
            finish(active, answer, 'Response complete.');
        } catch (error) {
            if (!isCurrent(active)) return;
            const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
            const serverMessage = error && typeof error === 'object' && 'serverMessage' in error ? error.serverMessage : undefined;
            log.error('Chat request failed.', { status, serverMessage, cause: error });
            const explanation = typeof serverMessage === 'string' && serverMessage.trim() ? serverMessage : failureMessage(isOnline());
            retries.set(active.message, { query: active.query, history: active.history });
            finish(active, active.answer ? `${active.answer}\n\n${explanation}` : explanation, explanation);
        }
    }

    function ask(text, { retry = null } = {}) {
        const query = String(text).trim();
        if (!query || request) return null;
        const history = retry?.history ?? apiHistory(messages, WELCOME_MESSAGE);
        add({ text: query, sender: 'user' });
        const message = { text: '', sender: 'bot' };
        add(message);
        const active = {
            id: ++nextId,
            query,
            history,
            message,
            answer: '',
            stage: 'Connecting…',
            started: now(),
            controller: new AbortController(),
        };
        request = active;
        persist();
        emit({ type: 'busy', busy: true });
        run(active);
        return active;
    }

    function cancel() {
        const active = request;
        if (!active) return;
        active.controller.abort();
        finish(active, active.answer ? `${active.answer}\n\n(Response stopped.)` : 'Response stopped.', 'Response stopped.');
    }

    function load() {
        messages = readHistory(storage, WELCOME_MESSAGE);
        emit({ type: 'history:reset' });
    }

    function clear() {
        cancel();
        messages = [{ sender: 'bot', text: WELCOME_MESSAGE }];
        persist();
        emit({ type: 'history:reset' });
        emit({ type: 'status', text: 'Chat history cleared.' });
    }

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        load,
        clear,
        ask,
        cancel,
        /** Conversation messages. Read-only by convention: change state through the methods above. */
        get messages() {
            return messages;
        },
        get activeRequest() {
            return request ? snapshot(request) : null;
        },
        get busy() {
            return request !== null;
        },
        retryFor(message) {
            return retries.get(message) ?? null;
        },
    };
}
