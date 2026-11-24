/**
 * Builds the RAG corpus (sections and chunks) from site content. Must not call paid APIs or Cloudflare.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MarkdownTextSplitter } from '@langchain/textsplitters';
import { glob } from 'glob';
import matter from 'gray-matter';
import { hasEvidence, ingestionText, sourceSections } from './content-normalization.mjs';
import { chunkId, corpusHash, namespaceFor, sourceHash, validateCorpus } from './corpus-contract.mjs';
import { publicSourceUrls } from './source-provenance.mjs';
import { AI_CONFIG } from '../../shared/ai/application.js';

/** @typedef {import('./corpus-contract.mjs').ValidatedCorpus} ValidatedCorpus */
/** @typedef {import('./corpus-contract.mjs').DraftChunk} DraftChunk */
/** @typedef {import('./corpus-contract.mjs').DraftCorpus} DraftCorpus */
/** @typedef {DraftChunk['metadata']} ChunkMetadata */
/** @typedef {Pick<ChunkMetadata, 'source' | 'type' | 'title' | 'url'>} SourceIdentity */
/** @typedef {{ heading: string, text: string }} Section */
/** @typedef {{ identity: SourceIdentity, sections: Section[] }} SourceEntry */
/** @typedef {{ source: string, target: string, section: string }} CanonicalLink */

// ---- Canonical evidence: link curated context to the public section it supports ----
/**
 * @param {DraftChunk[]} chunks
 * @param {Map<string, SourceEntry>} sources
 * @param {CanonicalLink[]} links
 * @param {number} maxSectionChars
 */
function linkCanonicalEvidence(chunks, sources, links, maxSectionChars) {
    const bySource = Map.groupBy(chunks, (chunk) => chunk.metadata.source);
    for (const link of links) {
        const target = sources.get(link.target);
        const sections = target?.sections.filter((section) => section.heading === link.section);
        if (!target || !sections || sections.length !== 1 || target.identity.type !== 'content')
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

// ---- Section chunking ----
/**
 * @param {SourceIdentity} identity
 * @param {Section[]} sections
 * @param {{ chunkSize: number, chunkOverlap: number, maxSectionChars: number }} config
 */
async function sectionChunks(identity, sections, config) {
    const splitter = new MarkdownTextSplitter(config);
    const sectionSplitter = new MarkdownTextSplitter({ chunkSize: config.maxSectionChars, chunkOverlap: config.chunkOverlap });
    /** @type {DraftChunk[]} */
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
                    metadata: {
                        ...identity,
                        section: section.heading,
                        recordType: 'section',
                        sectionIndex: parentIndex,
                        text,
                    },
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

// ---- Corpus build ----
const CHUNK_CONFIG = Object.freeze({ chunkSize: 2000, chunkOverlap: 200 });

/** @param {{ text: string, metadata: { title: string, section: string } }} chunk */
export function embeddingText(chunk) {
    const labels = [chunk.metadata.title, chunk.metadata.section].filter((label) => label && label !== 'Untitled');
    return labels.length ? `${labels.join(' — ')}\n\n${chunk.text}` : chunk.text;
}

/**
 * @param {{ embedding: { model: string, dimensions: number } }} corpus
 * @param {{ text: string, metadata: { title: string, section: string } }} chunk
 */
export function embeddingKey(corpus, chunk) {
    return sourceHash(`${corpus.embedding.model}\0${corpus.embedding.dimensions}\0${embeddingText(chunk)}`);
}

/**
 * @param {{ root?: string, embedding?: { model: string, dimensions: number }, chunking?: { chunkSize: number, chunkOverlap: number }, sourceUrls?: Map<string, string> }} [options]
 */
export async function buildCorpus({ root = process.cwd(), embedding = AI_CONFIG.embedding, chunking = CHUNK_CONFIG, sourceUrls } = {}) {
    const embeddingConfig = { model: embedding.model, dimensions: embedding.dimensions };
    /** @type {ValidatedCorpus['chunking']} */
    const chunkConfig = {
        chunkSize: chunking.chunkSize,
        chunkOverlap: chunking.chunkOverlap,
        maxSectionChars: AI_CONFIG.retrieval.maxSectionChars,
        embeddingLabels: true,
        normalizationVersion: 3,
    };
    if (
        typeof embeddingConfig.model !== 'string' ||
        !embeddingConfig.model.trim() ||
        !Number.isInteger(embeddingConfig.dimensions) ||
        embeddingConfig.dimensions <= 0
    ) {
        throw new Error('Invalid embedding configuration');
    }
    if (
        !Number.isInteger(chunkConfig.chunkSize) ||
        chunkConfig.chunkSize <= 0 ||
        !Number.isInteger(chunkConfig.chunkOverlap) ||
        chunkConfig.chunkOverlap < 0 ||
        chunkConfig.chunkOverlap >= chunkConfig.chunkSize ||
        chunkConfig.chunkSize > chunkConfig.maxSectionChars
    ) {
        throw new Error('Invalid chunk configuration');
    }
    const files = (await glob('content/**/*.md', { cwd: root, nodir: true })).sort();
    const urls = sourceUrls ?? (await publicSourceUrls(root));
    if (!(urls instanceof Map)) throw new Error('Source provenance must be a source-to-URL map');
    /** @type {CanonicalLink[]} */
    const links = [];
    /** @type {Map<string, SourceEntry>} */
    const sourceContent = new Map();
    /** @type {DraftCorpus} */
    const corpus = {
        version: 2,
        embedding: embeddingConfig,
        chunking: chunkConfig,
        sources: [],
        chunks: [],
        counts: { files: files.length, includedFiles: 0, draftFiles: 0, emptyFiles: 0, chunks: 0 },
    };
    for (const file of files) {
        const source = file.split(path.sep).join('/');
        const raw = await readFile(path.resolve(root, file), 'utf8');
        const { data, content } = matter(raw);
        const isContext = source.startsWith('content/_context/');
        const indexContent = data.draft ? '' : ingestionText(content, { rejectUnclosedComments: isContext });
        const status = data.draft ? 'draft' : indexContent.trim() ? 'included' : 'empty';
        corpus.sources.push({ source, hash: sourceHash(raw), status });
        if (status !== 'included') {
            corpus.counts[status === 'draft' ? 'draftFiles' : 'emptyFiles']++;
            continue;
        }
        corpus.counts.includedFiles++;
        const url = urls.get(source);
        if (!isContext && !url) throw new Error(`Missing published Hugo URL for ${source}`);
        /** @type {SourceIdentity} */
        const identity = {
            source,
            type: isContext ? 'context' : 'content',
            title: String(data.title || 'Untitled'),
            ...(isContext ? {} : { url }),
        };
        const sections = sourceSections(indexContent);
        sourceContent.set(source, { identity, sections });
        if (data.retrievalSource !== undefined || data.retrievalSection !== undefined) {
            if (typeof data.retrievalSource !== 'string' || typeof data.retrievalSection !== 'string' || !data.retrievalSection.trim()) {
                throw new Error(`Invalid retrieval source/section in ${source}`);
            }
            links.push({ source, target: data.retrievalSource, section: data.retrievalSection });
        }
        corpus.chunks.push(...(await sectionChunks(identity, sections, chunkConfig)));
    }
    linkCanonicalEvidence(corpus.chunks, sourceContent, links, chunkConfig.maxSectionChars);
    corpus.counts.chunks = corpus.chunks.length;
    const hash = corpusHash(corpus);
    const namespace = namespaceFor(hash);
    const built = {
        ...corpus,
        hash,
        namespace,
        chunks: corpus.chunks.map((chunk) => ({
            id: chunkId(namespace, chunk.metadata.source, chunk.chunkIndex),
            ...chunk,
        })),
    };
    validateCorpus(built);
    return built;
}
