import { createParser } from 'eventsource-parser';
import { CONFIG } from './application.js';

const LOG_TTL_SECONDS = 2592000;

/**
 * Accumulates the answer from the widget's SSE and stores the exchange at most once. `observe` takes the stream's
 * bytes; `finish` stores whatever has been seen so far (an error event stores it immediately, so an aborted stream
 * still keeps its partial answer).
 */
function createRecorder(kv, query, { context, now, id }) {
    const decoder = new TextDecoder();
    let response = '';
    let usage = null;
    let error = null;
    let stored = false;

    const store = () => {
        const timestamp = now();
        const payload = { timestamp, query, response, usage, ...(error ? { error } : {}) };
        const saved = kv
            .put(`${CONFIG.KV_PREFIX}${timestamp}:${id()}`, JSON.stringify(payload), {
                expirationTtl: LOG_TTL_SECONDS,
                metadata: { timestamp, version: 2 },
            })
            .catch((failure) => console.error('Log Flush Error', failure));
        context?.waitUntil?.(saved);
    };
    const finish = () => {
        if (stored) return;
        stored = true;
        store();
    };
    const parser = createParser({
        onEvent: ({ data }) => {
            if (data === '[DONE]') return;
            let event;
            try {
                event = JSON.parse(data);
            } catch {
                return; // not JSON: nothing to record
            }
            if (event.response) response += event.response;
            if (event.usage) usage = event.usage;
            if (event.error) {
                error = event.error;
                finish();
            }
        },
    });
    return { observe: (bytes) => parser.feed(decoder.decode(bytes, { stream: true })), finish };
}

/**
 * Passes the answer stream through unchanged and stores the exchange once: when it ends, errors, or the client
 * disconnects. A TransformStream would miss the disconnect, so the stream is built by hand and cancels upstream too.
 */
export function saveChatLog(
    env,
    query,
    responseStream,
    context = null,
    { now = () => new Date().toISOString(), id = () => crypto.randomUUID() } = {},
) {
    const kv = env?.CHAT_LOGS;
    if (!kv) return responseStream;
    const recorder = createRecorder(kv, query, { context, now, id });
    const reader = responseStream.getReader();
    return new ReadableStream({
        async pull(controller) {
            let result;
            try {
                result = await reader.read();
            } catch (error) {
                recorder.finish();
                controller.error(error);
                return;
            }
            if (result.done) {
                recorder.finish();
                controller.close();
                return;
            }
            recorder.observe(result.value);
            controller.enqueue(result.value);
        },
        cancel(reason) {
            recorder.finish();
            return reader.cancel(reason);
        },
    });
}

// Legacy or foreign records (no metadata, or a version other than 2) must never fail the whole page.
async function readRecord(kv, key) {
    if (key.metadata?.version !== 2) {
        console.error('Unsupported log record version:', key.name);
        return null;
    }
    try {
        const record = await kv.get(key.name, 'json');
        if (record) return { ...record, id: key.name };
        console.error('Log record missing:', key.name);
    } catch (error) {
        console.error('Log record read failed:', key.name, error);
    }
    return null;
}

export async function fetchChatLogs(env, limit, cursor) {
    const kv = env?.CHAT_LOGS;
    if (!kv) throw new Error('KV binding missing');
    const listing = await kv.list({ prefix: CONFIG.KV_PREFIX, limit, ...(cursor && { cursor }) });
    const records = await Promise.all(listing.keys.toReversed().map((key) => readRecord(kv, key)));
    const data = records.filter(Boolean);
    return { data, meta: { count: data.length, limit, cursor: listing.cursor, has_more: !listing.list_complete } };
}
