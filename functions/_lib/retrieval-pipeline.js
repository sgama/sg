// The one retrieval pipeline: embed a query, search the index, expand parent sections and build
// bounded context. Production (AiService) and the evaluation harness both call it, so the evaluation
// measures the code that serves visitors. Only the transport adapters differ, and they are injected.
import { contextFromMatches, expandSectionMatches, parentSectionIds } from './retrieval.js';

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
