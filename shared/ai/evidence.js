// Turns AI Search chunks into what the model reads and what the visitor sees. Visitors only get public pages as sources;
// internal `_context` items still feed the model but are never cited.
/** @typedef {{ title: string, text: string }} Result */
/** @typedef {{ title: string, url: string, text: string }} Evidence */
/** @typedef {{ text?: string, item?: { metadata?: Record<string, unknown> } }} Chunk the fields used from an AI Search chunk */

const EXCERPT_CHARS = 600;

/** @param {unknown} url @returns {url is string} */
export const isPublicUrl = (url) => typeof url === 'string' && /^\/(?!\/)/.test(url) && !/[\\\r\n]/.test(url) && !/\/_context(?:\/|$)/.test(url);

/**
 * @param {Chunk[]} chunks
 * @param {number} maxChars bound on the text handed to the model
 * @returns {{ results: Result[], evidence: Evidence[] }}
 */
export function searchOutput(chunks, maxChars) {
    /** @type {Result[]} */
    const results = [];
    /** @type {Map<string, Evidence>} */
    const evidence = new Map();
    let used = 0;
    for (const chunk of chunks) {
        const remaining = maxChars - used;
        if (remaining <= 0) break;
        const text = typeof chunk?.text === 'string' ? chunk.text.trim().slice(0, remaining) : '';
        if (!text) continue;
        used += text.length;
        const { title, url } = chunk.item?.metadata ?? {};
        const label = typeof title === 'string' ? title : '';
        results.push({ title: label, text });
        if (isPublicUrl(url) && !evidence.has(url)) evidence.set(url, { title: label || 'Source', url, text: text.slice(0, EXCERPT_CHARS) });
    }
    return { results, evidence: [...evidence.values()] };
}
