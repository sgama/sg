// Retrieval-result cache. AiService depends only on the store contract below, so
// the backing store can be swapped (Workers Cache API or another binding) without touching retrieval code.
//
// Contract: get(namespace, query) -> payload | null, put(namespace, query, payload).
// Both methods must never reject: a failing cache is a miss, not an outage.

import { sha256Hex } from '../../shared/ai/retrieval.js';

/** @typedef {{ contextText: string, evidence: import('../../shared/ai/retrieval.js').Excerpt[] }} RetrievalPayload */
/** @typedef {{ get(namespace: string | undefined, query: string): Promise<unknown>, put(namespace: string | undefined, query: string, payload: RetrievalPayload): Promise<void> }} RetrievalStore */

/**
 * @param {unknown} payload
 * @returns {payload is RetrievalPayload}
 */
export function isValidRetrievalCachePayload(payload) {
    return (
        !!payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        'contextText' in payload &&
        typeof payload.contextText === 'string' &&
        'evidence' in payload &&
        Array.isArray(payload.evidence)
    );
}

const CACHE_SCHEME = 'v2';
const CACHE_TTL_SECONDS = 86400;

// Keys depend on the corpus namespace and the query the visitor asked, plus the history it was read in
// (AiService passes both), so a hit skips the query-rewrite call. A new corpus (new namespace) can never
// serve stale evidence. The scheme prefix lets a change to the payload shape invalidate old entries.
/** @param {string | undefined} namespace @param {string} query */
export async function retrievalCacheKey(namespace, query) {
    const input = `${CACHE_SCHEME}:${namespace ?? ''}:${query}`;
    return `https://rag-cache.internal/${CACHE_SCHEME}?ns=${encodeURIComponent(namespace ?? '')}&q=${await sha256Hex(input)}`;
}

/**
 * Store backed by the Workers Cache API (`caches.default`).
 * @param {Cache} cache
 * @returns {RetrievalStore}
 */
export function workersCacheStore(cache) {
    return {
        async get(namespace, query) {
            try {
                const hit = await cache.match(new Request(await retrievalCacheKey(namespace, query)));
                return hit ? await hit.json() : null;
            } catch (err) {
                console.error('Retrieval cache read failed:', err);
                return null;
            }
        },
        async put(namespace, query, payload) {
            try {
                const response = new Response(JSON.stringify(payload), {
                    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_TTL_SECONDS}` },
                });
                await cache.put(new Request(await retrievalCacheKey(namespace, query)), response);
            } catch (err) {
                console.error('Retrieval cache write failed:', err);
            }
        },
    };
}
