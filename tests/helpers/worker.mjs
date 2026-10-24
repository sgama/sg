import worker from '../../functions/worker.js';

/** Calls the Worker the way a request context from createContext() describes it: { request, env, waitUntil? }. */
export const onRequest = ({ request, env, waitUntil }) =>
    worker.fetch(request, env, { waitUntil: waitUntil ?? (() => {}), passThroughOnException() {}, props: {} });
