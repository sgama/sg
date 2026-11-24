/**
 * Pure retrieval stages shared by the Worker and offline evals: score filter, parent/canonical section expansion,
 * context assembly and public-evidence selection. Must not perform I/O itself; callers inject embed/search/fetchSections.
 */
import { AI_CONFIG } from './application.js';

/** @typedef {{ id?: string, score?: number, metadata?: Record<string, unknown> }} Match */
/** @typedef {{ title?: string, url?: string, section?: string, text: string }} Excerpt */

/**
 * The parent and canonical sections a match points at, canonical first, validated. Both consumers must
 * accept the same records, so the shape check lives here rather than in each of them. Order is not
 * semantic: callers index the result by section key.
 * @param {Match} match
 */
function sectionReferences(match) {
    assertRecordType(match);
    const metadata = match.metadata ?? {};
    return ['canonical', 'parent']
        .filter((prefix) => metadata[`${prefix}Index`] !== undefined)
        .map((prefix) => {
            const source = metadata[`${prefix}Source`] === undefined ? metadata.source : metadata[`${prefix}Source`];
            const index = metadata[`${prefix}Index`];
            if (typeof source !== 'string' || !source.trim() || typeof index !== 'number' || !Number.isInteger(index) || index >= 0) {
                throw new Error('Invalid parent section reference');
            }
            return { prefix, source, index };
        });
}

/** @param {string} text */
export async function sha256Hex(text) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {string | undefined} namespace @param {string} source @param {number} index */
export const corpusRecordId = (namespace, source, index) => sha256Hex(`${namespace}\0${source}\0${index}`);

/** @param {Match} match */
function assertRecordType(match) {
    const type = match.metadata?.recordType;
    if (type !== 'chunk' && type !== 'section') throw new Error('Unsupported corpus record type');
}

/** @param {Match[]} matches @param {string} [namespace] */
export async function parentSectionIds(matches, namespace) {
    // Record-type check first, so an unsupported record reports before any reference lookup.
    for (const match of matches) assertRecordType(match);
    const children = matches.flatMap((match) => sectionReferences(match));
    if (children.length && !namespace) throw new Error('Section expansion requires a corpus namespace');
    return [...new Set(await Promise.all(children.map(({ source, index }) => corpusRecordId(namespace, source, index))))];
}

/** @param {any} section @param {string} prefix 'canonical' sections must additionally be page content. */
function isValidSection(section, prefix) {
    const metadata = section?.metadata;
    return (
        !!metadata &&
        metadata.recordType === 'section' &&
        typeof metadata.text === 'string' &&
        !!metadata.text.trim() &&
        metadata.text.length <= AI_CONFIG.retrieval.maxSectionChars &&
        (prefix !== 'canonical' || metadata.type === 'content')
    );
}

/** Cosine index: higher is better. A missing or non-numeric score cannot be judged, so it is kept. @param {Match[]} matches */
function filterByMinScore(matches) {
    const minScore = AI_CONFIG.retrieval.minScore;
    return matches.filter((match) => typeof minScore !== 'number' || typeof match?.score !== 'number' || match.score >= minScore);
}

/** @param {Match[]} matches @param {unknown} sections */
export function expandSectionMatches(matches, sections) {
    if (!Array.isArray(sections)) throw new Error('Invalid section expansion response');
    /** @type {Match[]} */
    const expanded = [];
    const seen = new Set();
    const sectionByKey = new Map(sections.map((section) => [`${section.metadata?.source}\0${section.metadata?.sectionIndex}`, section]));
    /** @param {Match} evidence */
    const append = (evidence) => {
        if (evidence.id && seen.has(evidence.id)) return;
        if (evidence.id) seen.add(evidence.id);
        expanded.push(evidence);
    };
    for (const match of matches) {
        let evidence = match;
        for (const { prefix, source, index } of sectionReferences(match)) {
            const section = sectionByKey.get(`${source}\0${index}`);
            if (!isValidSection(section, prefix)) throw new Error('Missing or invalid parent section evidence');
            if (prefix === 'canonical') append({ ...section, score: match.score });
            else evidence = { ...section, score: match.score };
        }
        append(evidence);
    }
    return expanded;
}

/** @param {Match[]} matches @param {(excerpt: Excerpt) => void} [onExcerpt] */
export function contextFromMatches(matches, onExcerpt) {
    let context = '';
    for (const match of matches) {
        const metadata = match.metadata;
        if (typeof metadata?.text !== 'string' || !metadata.text.trim()) continue;
        const identity = Object.fromEntries(
            ['title', 'url', 'section'].filter((key) => typeof metadata[key] === 'string' && metadata[key]).map((key) => [key, metadata[key]]),
        );
        // Keep source identity with each excerpt so a later prompt can cite the public page and keep
        // excerpt blocks visually distinct when multiple hits are folded into one context string.
        const header = Object.keys(identity).length ? `Source: ${JSON.stringify(identity)}\n` : '';
        const separator = context ? '\n---\n' : '';
        const remaining = AI_CONFIG.retrieval.maxContextChars - context.length - separator.length - header.length;
        if (remaining <= 0) break;
        const text = metadata.text.slice(0, remaining);
        context += separator + header + text;
        onExcerpt?.({ ...identity, text });
    }
    return context;
}

// Visitors only see public pages as evidence. Internal `_context` excerpts still feed the model.
/** @param {Excerpt} excerpt */
function isPublicEvidence(excerpt) {
    return (
        typeof excerpt.url === 'string' && /^\/(?!\/)/.test(excerpt.url) && !/[\\\r\n]/.test(excerpt.url) && !/\/_context(?:\/|$)/.test(excerpt.url)
    );
}

/**
 * @param {{ retrievalQuery: string, namespace?: string, embed: (text: string) => Promise<number[]>, search: (vector: number[]) => Promise<Match[]>, fetchSections: (ids: string[]) => Promise<unknown> }} options
 */
export async function retrieveEvidence({ retrievalQuery, namespace, embed, search, fetchSections }) {
    const vector = await embed(retrievalQuery);
    const matches = await search(vector);
    if (!Array.isArray(matches)) throw new Error('Invalid retrieval result');
    const relevant = filterByMinScore(matches);
    const ids = await parentSectionIds(relevant, namespace);
    const sections = ids.length ? await fetchSections(ids) : [];
    const expanded = expandSectionMatches(relevant, sections);
    /** @type {Excerpt[]} */
    const evidence = [];
    const contextText = contextFromMatches(expanded, (excerpt) => {
        if (isPublicEvidence(excerpt)) evidence.push(excerpt);
    });
    return { retrievalQuery, matches: expanded, contextText, evidence };
}
