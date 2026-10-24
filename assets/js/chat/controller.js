import { apiHistory, readHistory, STORAGE_KEY } from './history.js';
import { streamAnswer as fetchAnswer } from './stream.js';
import { publicEvidence } from './evidence.js';
import { formatResponseMetrics } from './metrics.js';
import { failureMessage, stageLabel } from './session.js';

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
 *   stage           { request }      the server reported a new progress stage
 *   answer          { request }      streamed answer text advanced
 *   status          { text }         a user-facing status line changed
 */
export function createChatController({
    storage,
    streamAnswer = fetchAnswer,
    isOnline = () => globalThis.navigator?.onLine !== false,
    now = () => performance.now(),
    log = console,
} = {}) {
    const listeners = new Set();
    const retries = new WeakMap();
    let messages = [];
    let request = null;

    const emit = (event) => listeners.forEach((listener) => listener(event));
    const persist = () =>
        storage.set(
            STORAGE_KEY,
            messages.filter((message) => message.text.trim()),
        );
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
        emit({ type: 'stage', request: active });
    }

    function onEvidence(active, value) {
        if (isCurrent(active)) active.message.evidence = publicEvidence(value);
    }

    function onMetrics(active, metrics) {
        if (!isCurrent(active)) return;
        if (!formatResponseMetrics(metrics)) throw new Error('Invalid response metrics');
        active.message.metrics = metrics;
    }

    function onAnswer(active, answer) {
        if (!isCurrent(active)) return;
        active.answer = answer;
        emit({ type: 'answer', request: active });
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
            log.error('Chat request failed.', error);
            const explanation = failureMessage(isOnline());
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
            return request;
        },
        get busy() {
            return request !== null;
        },
        retryFor(message) {
            return retries.get(message) ?? null;
        },
    };
}
