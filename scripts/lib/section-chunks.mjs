import { MarkdownTextSplitter } from '@langchain/textsplitters';
import { hasEvidence } from './content-normalization.mjs';

export async function sectionChunks(identity, sections, config) {
    const splitter = new MarkdownTextSplitter(config);
    const sectionSplitter = new MarkdownTextSplitter({ chunkSize: config.maxSectionChars, chunkOverlap: config.chunkOverlap });
    const chunks = [];
    let chunkIndex = 0;
    let sectionIndex = -1;
    for (const section of sections) {
        if (!hasEvidence(section.text)) continue;
        for (const text of await sectionSplitter.splitText(section.text)) {
            const segments = await splitter.splitText(text);
            const parentIndex = segments.length > 1 ? sectionIndex-- : null;
            if (parentIndex !== null) {
                chunks.push({
                    chunkIndex: parentIndex,
                    text,
                    metadata: { ...identity, section: section.heading, recordType: 'section', sectionIndex: parentIndex, text },
                });
            }
            for (const segment of segments) {
                chunks.push({
                    chunkIndex: chunkIndex++,
                    text: segment,
                    metadata: {
                        ...identity,
                        recordType: 'chunk',
                        section: section.heading,
                        ...(parentIndex !== null ? { parentIndex } : {}),
                        text: segment,
                    },
                });
            }
        }
    }
    return chunks;
}
