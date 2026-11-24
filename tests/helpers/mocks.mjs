import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

/**
 * Mock factories for common test objects
 * Provides reusable mock objects for requests, SSE streams and the AI SDK/AI Search fakes.
 */

/**
 * Create a mock Request context for API handlers
 * @param {Object} options
 * @param {string} options.method - HTTP method
 * @param {string} options.url - Request URL
 * @param {Object} options.body - Request body (will be JSON stringified)
 * @param {Object} options.env - Environment bindings
 * @param {Function} options.waitUntil - waitUntil implementation
 * @param {string} options.origin - Origin header value
 * @returns {Object} Request context with request, env, and waitUntil
 */
export function createContext({
    method = 'GET',
    url = 'https://example.com/api',
    body,
    env = {},
    waitUntil,
    origin = 'https://samsongama.com',
} = {}) {
    const request = new Request(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(origin ? { Origin: origin } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return {
        request,
        env,
        ...(waitUntil ? { waitUntil } : {}),
    };
}

/**
 * Create a mock SSE stream from text chunks
 * @param  {...string} sseLines - SSE formatted lines
 * @returns {ReadableStream} Stream of SSE data
 */
export function makeStream(...sseLines) {
    const encoder = new TextEncoder();
    const chunks = sseLines.map((l) => encoder.encode(l + '\n'));
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
}

export function makeProviderStream(response, usage) {
    return makeStream(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: response } }] })}\n`,
        ...(usage ? [`data: ${JSON.stringify({ choices: [], usage })}\n`] : []),
        'data: [DONE]\n',
    );
}

/**
 * Drain a readable stream to string
 * @param {ReadableStream} stream
 * @returns {Promise<string>} The complete stream content
 */
export function drainStream(stream) {
    return new Response(stream).text();
}

/** One AI Search chunk as `instance.search()` returns it. */
export function searchChunk({ text, title, url, key = 'content/page/index.md' }) {
    return {
        id: `${key}#${text.slice(0, 8)}`,
        type: 'chunk',
        score: 0.9,
        text,
        item: { key, metadata: { ...(title ? { title } : {}), ...(url ? { url } : {}) } },
    };
}

/** Fake AI Search instance: records requests, answers with `chunks` (or throws `failure`). */
export function fakeSearchInstance(chunks = [], failure) {
    const calls = [];
    return {
        calls,
        async search(request) {
            calls.push(request);
            if (failure) throw failure;
            return { search_query: request.query, chunks };
        },
    };
}

const usage = (input, output) => ({
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
});
const finish = (reason, input, output) => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage: usage(input, output) });

/** Model stream chunks for a final text answer. */
export const answerStep = (...deltas) => [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    ...deltas.map((delta) => ({ type: 'text-delta', id: 't', delta })),
    { type: 'text-end', id: 't' },
    finish('stop', 20, 5),
];

/** Model stream chunks for a searchPortfolio tool call. */
export const searchStep = (query) => [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'call-1', toolName: 'searchPortfolio', input: JSON.stringify({ query }) },
    finish('tool-calls', 10, 3),
];

/** A stream that fails before producing anything. */
export const failingStep = (error = new Error('model down')) => [
    { type: 'stream-start', warnings: [] },
    { type: 'error', error },
];

/**
 * Scripted model: each doStream call plays the next step (an array of chunks, or an Error to throw from doStream).
 * `hang` steps never end until the call's abort signal fires, like a provider honouring a closed connection.
 */
export function scriptedModel(...steps) {
    let call = 0;
    return new MockLanguageModelV3({
        doStream: async ({ abortSignal }) => {
            const step = steps[call++];
            if (step instanceof Error) throw step;
            if (step === 'hang') {
                return {
                    stream: new ReadableStream({
                        start(controller) {
                            abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason ?? new Error('aborted')), {
                                once: true,
                            });
                        },
                    }),
                };
            }
            return { stream: simulateReadableStream({ chunks: step, initialDelayInMs: null, chunkDelayInMs: null }) };
        },
    });
}

/** Parses the JSON `data:` frames of an SSE body. */
export const sseEvents = (text) =>
    text
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
