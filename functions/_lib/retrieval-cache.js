// Retrieval-result cache. AiService depends only on the store contract below, so
// the backing store can be swapped (Workers Cache API, in-memory, or another
// binding) without touching retrieval code.
//
// Contract: get(namespace, query) -> payload | null, put(namespace, query, payload).
// Both methods must never reject: a failing cache is a miss, not an outage.

const CACHE_SCHEME = 'v1';
const CACHE_TTL_SECONDS = 86400;

// Keys depend on the corpus namespace and the contextualized query only, so a new corpus
// (new namespace) can never serve stale evidence. The scheme prefix lets a change to the
// payload shape invalidate old entries by bumping the version.
export async function retrievalCacheKey(namespace, query) {
    const input = `${CACHE_SCHEME}:${namespace ?? ''}:${query}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `https://rag-cache.internal/${CACHE_SCHEME}?ns=${encodeURIComponent(namespace ?? '')}&q=${hex}`;
}

/** Store backed by the Workers Cache API (`caches.default`). */
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

/**
 * In-process store for tests and local runs. Values are copied, so callers cannot alias them.
 * Bounded: the oldest entry is evicted once `maxEntries` is reached (Map keeps insertion order).
 */
export function memoryStore({ maxEntries = 100 } = {}) {
    const entries = new Map();
    return {
        async get(namespace, query) {
            const value = entries.get(await retrievalCacheKey(namespace, query));
            return value === undefined ? null : structuredClone(value);
        },
        async put(namespace, query, payload) {
            const key = await retrievalCacheKey(namespace, query);
            entries.delete(key);
            entries.set(key, structuredClone(payload));
            if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        },
        get size() {
            return entries.size;
        },
    };
}
