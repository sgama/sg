// Retrieval: pure helpers that turn Vectorize matches into record IDs, parent-section expansion and bounded
// model context, plus the one pipeline (retrieveEvidence) that chains them. Production (AiService) and the
// evaluation harness both call the pipeline, so the evaluation measures the code that serves visitors; only
// the transport adapters (embed, search, fetchSections) differ, and they are injected. No bindings here.
import { AI_CONFIG } from './application.js';

export async function corpusRecordId(namespace, source, index) {
    const bytes = new TextEncoder().encode(`${namespace}\0${source}\0${index}`);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function parentSectionIds(matches, namespace) {
    for (const match of matches) {
        if (!['chunk', 'section'].includes(match.metadata?.recordType)) throw new Error('Unsupported corpus record type');
    }
    const children = matches.flatMap((match) =>
        ['parent', 'canonical']
            .filter((prefix) => match.metadata?.[`${prefix}Index`] !== undefined)
            .map((prefix) => ({
                source: match.metadata[`${prefix}Source`] === undefined ? match.metadata.source : match.metadata[`${prefix}Source`],
                index: match.metadata[`${prefix}Index`],
            })),
    );
    if (children.length && !namespace) throw new Error('Section expansion requires a corpus namespace');
    return [
        ...new Set(
            await Promise.all(
                children.map((reference) => {
                    if (
                        typeof reference.source !== 'string' ||
                        !reference.source.trim() ||
                        !Number.isInteger(reference.index) ||
                        reference.index >= 0
                    ) {
                        throw new Error('Invalid parent section reference');
                    }
                    return corpusRecordId(namespace, reference.source, reference.index);
                }),
            ),
        ),
    ];
}

export function expandSectionMatches(matches, sections) {
    if (!Array.isArray(sections)) throw new Error('Invalid section expansion response');
    const expanded = [];
    const seen = new Set();
    const sectionByKey = new Map(sections.map((section) => [`${section.metadata?.source}\0${section.metadata?.sectionIndex}`, section]));
    const append = (evidence) => {
        if (evidence.id && seen.has(evidence.id)) return;
        if (evidence.id) seen.add(evidence.id);
        expanded.push(evidence);
    };
    for (const match of matches) {
        if (!['chunk', 'section'].includes(match.metadata?.recordType)) throw new Error('Unsupported corpus record type');
        let evidence = match;
        for (const prefix of ['canonical', 'parent']) {
            if (match.metadata?.[`${prefix}Index`] === undefined) continue;
            if (!Number.isInteger(match.metadata[`${prefix}Index`]) || match.metadata[`${prefix}Index`] >= 0) {
                throw new Error('Invalid parent section reference');
            }
            const section = sectionByKey.get(`${match.metadata[`${prefix}Source`] ?? match.metadata.source}\0${match.metadata[`${prefix}Index`]}`);
            if (
                !section ||
                section.metadata.recordType !== 'section' ||
                typeof section.metadata.text !== 'string' ||
                !section.metadata.text.trim() ||
                section.metadata.text.length > AI_CONFIG.retrieval.maxSectionChars ||
                (prefix === 'canonical' && section.metadata.type !== 'content')
            )
                throw new Error('Missing or invalid parent section evidence');
            if (prefix === 'canonical') append({ ...section, score: match.score });
            else evidence = { ...section, score: match.score };
        }
        append(evidence);
    }
    return expanded;
}

export function contextFromMatches(matches, onExcerpt) {
    let context = '';
    for (const match of matches) {
        const metadata = match.metadata;
        if (typeof metadata?.text !== 'string' || !metadata.text.trim()) continue;
        const identity = Object.fromEntries(
            ['title', 'url', 'section'].filter((key) => typeof metadata[key] === 'string' && metadata[key]).map((key) => [key, metadata[key]]),
        );
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
function isPublicEvidence(excerpt) {
    return (
        typeof excerpt.url === 'string' && /^\/(?!\/)/.test(excerpt.url) && !/[\\\r\n]/.test(excerpt.url) && !/\/_context(?:\/|$)/.test(excerpt.url)
    );
}

export async function retrieveEvidence({ retrievalQuery, namespace, embed, search, fetchSections }) {
    const vector = await embed(retrievalQuery);
    const matches = await search(vector);
    if (!Array.isArray(matches)) throw new Error('Invalid retrieval result');
    const ids = await parentSectionIds(matches, namespace);
    const sections = ids.length ? await fetchSections(ids) : [];
    const expanded = expandSectionMatches(matches, sections);
    const evidence = [];
    const contextText = contextFromMatches(expanded, (excerpt) => {
        if (isPublicEvidence(excerpt)) evidence.push(excerpt);
    });
    return { retrievalQuery, matches: expanded, contextText, evidence };
}
