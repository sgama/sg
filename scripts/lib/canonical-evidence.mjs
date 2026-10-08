import { hasEvidence } from './content-normalization.mjs';

export function linkCanonicalEvidence(chunks, sources, links, maxSectionChars) {
    const bySource = new Map();
    for (const chunk of chunks) {
        const records = bySource.get(chunk.metadata.source) ?? [];
        records.push(chunk);
        bySource.set(chunk.metadata.source, records);
    }
    for (const link of links) {
        const target = sources.get(link.target);
        const sections = target?.sections.filter((section) => section.heading === link.section);
        if (!target || sections.length !== 1 || target.identity.type !== 'content')
            throw new Error(`Missing or ambiguous public retrieval section for ${link.source}`);
        const section = sections[0];
        if (!hasEvidence(section.text)) throw new Error(`Empty public retrieval section for ${link.source}`);
        if (section.text.length > maxSectionChars) throw new Error(`Linked retrieval section exceeds context budget for ${link.source}`);
        const records = bySource.get(link.target) ?? [];
        let canonical = records.find((chunk) => chunk.metadata.section === link.section && chunk.metadata.recordType === 'section');
        if (!canonical) {
            const index = Math.min(0, ...records.map((chunk) => chunk.chunkIndex)) - 1;
            canonical = {
                chunkIndex: index,
                text: section.text,
                metadata: { ...target.identity, section: section.heading, recordType: 'section', sectionIndex: index, text: section.text },
            };
            chunks.push(canonical);
            records.push(canonical);
            bySource.set(link.target, records);
        }
        for (const chunk of bySource.get(link.source) ?? []) {
            if (chunk === canonical) throw new Error(`Canonical linkage cannot reference itself: ${link.source}`);
            chunk.metadata.canonicalSource = link.target;
            chunk.metadata.canonicalIndex = canonical.chunkIndex;
        }
    }
}
