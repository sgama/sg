import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MarkdownTextSplitter } from '@langchain/textsplitters';
import { glob } from 'glob';
import matter from 'gray-matter';
import { z } from 'zod';
import { hasEvidence, ingestionText, sourceSections } from './content-normalization.mjs';
import { publicSourceUrls } from './source-provenance.mjs';
import { AI_CONFIG } from '../../functions/_lib/application.js';
export { ingestionText, sourceSections } from './content-normalization.mjs';

// ---- Contract: identity, hashing and schema validation of a corpus ----
const digest = (value) => createHash('sha256').update(value).digest('hex');
export const namespaceFor = (hash) => `corpus-${hash.slice(0, 56)}`;
export const chunkId = (namespace, source, index) => digest(`${namespace}\0${source}\0${index}`);
const nonempty = z.string().trim().min(1);
const negativeIndex = z.number().int().negative();
const metadataSchema = z.object({
    source: nonempty,
    type: z.enum(['context', 'content']),
    title: nonempty,
    section: z.string(),
    text: nonempty,
    url: z
        .string()
        .regex(/^\/(?!\/)/)
        .optional(),
    recordType: z.enum(['chunk', 'section']),
    sectionIndex: negativeIndex.optional(),
    parentIndex: negativeIndex.optional(),
    parentSource: nonempty.optional(),
    canonicalIndex: negativeIndex.optional(),
    canonicalSource: nonempty.optional(),
});
const schema = z.object({
    version: z.literal(2),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    namespace: z.string().regex(/^corpus-[a-f0-9]{56}$/),
    embedding: z.object({ model: nonempty, dimensions: z.number().int().positive() }),
    chunking: z.object({
        chunkSize: z.number().int().positive(),
        chunkOverlap: z.number().int().nonnegative(),
        maxSectionChars: z.number().int().positive(),
        embeddingLabels: z.boolean(),
        normalizationVersion: z.literal(3),
    }),
    sources: z.array(z.object({ source: nonempty, hash: nonempty, status: z.enum(['included', 'draft', 'empty']) })),
    chunks: z.array(z.object({ id: nonempty, chunkIndex: z.number().int(), text: nonempty, metadata: metadataSchema })),
    counts: z.object({
        files: z.number().int().nonnegative(),
        includedFiles: z.number().int().nonnegative(),
        draftFiles: z.number().int().nonnegative(),
        emptyFiles: z.number().int().nonnegative(),
        chunks: z.number().int().nonnegative(),
    }),
});

export function corpusHash(corpus) {
    return digest(
        JSON.stringify({
            version: corpus.version,
            embedding: corpus.embedding,
            chunking: corpus.chunking,
            sources: corpus.sources,
            chunks: corpus.chunks.map(({ chunkIndex, text, metadata }) => ({ chunkIndex, text, metadata })),
        }),
    );
}

export function validateCorpus(corpus) {
    schema.parse(corpus);
    const ids = new Set();
    const records = new Map();
    const includedSources = new Set(corpus.sources.filter((source) => source.status === 'included').map((source) => source.source));
    if (new Set(corpus.sources.map((source) => source.source)).size !== corpus.sources.length) throw new Error('Duplicate corpus source');
    for (const chunk of corpus.chunks) {
        if (ids.has(chunk.id)) throw new Error(`Duplicate chunk ID: ${chunk.id}`);
        ids.add(chunk.id);
        records.set(`${chunk.metadata.source}\0${chunk.chunkIndex}`, chunk);
    }
    if (corpusHash(corpus) !== corpus.hash || namespaceFor(corpus.hash) !== corpus.namespace)
        throw new Error('Corpus hash or namespace does not match its contents');
    for (const chunk of corpus.chunks) {
        const metadata = chunk.metadata;
        if (!includedSources.has(metadata.source)) throw new Error(`Evidence source is not included: ${chunk.id}`);
        if (chunk.id !== chunkId(corpus.namespace, metadata.source, chunk.chunkIndex)) throw new Error(`Invalid chunk ID: ${chunk.id}`);
        if (chunk.text !== metadata.text) throw new Error(`Inconsistent evidence text: ${chunk.id}`);
        if (metadata.type === 'context' && metadata.url !== undefined) throw new Error(`Internal evidence has a public URL: ${chunk.id}`);
        if (metadata.type === 'content' && !metadata.url) throw new Error(`Public evidence is missing its URL: ${chunk.id}`);
        if (metadata.url && /[\\\r\n]/.test(metadata.url)) throw new Error(`Invalid public evidence URL: ${chunk.id}`);
        if (metadata.recordType !== 'section' && (chunk.chunkIndex < 0 || metadata.sectionIndex !== undefined))
            throw new Error(`Invalid child record: ${chunk.id}`);
        for (const prefix of ['parent', 'canonical']) {
            const index = metadata[`${prefix}Index`];
            const source = metadata[`${prefix}Source`];
            if (source !== undefined && index === undefined) throw new Error(`Invalid ${prefix} source: ${chunk.id}`);
            if (prefix === 'canonical' && index !== undefined && source === undefined) throw new Error(`Missing canonical source: ${chunk.id}`);
            if (index !== undefined) {
                const parent = records.get(`${source ?? metadata.source}\0${index}`);
                if (!parent || parent.metadata.recordType !== 'section' || parent.id === chunk.id)
                    throw new Error(`Missing or invalid ${prefix} section: ${chunk.id}`);
                if (prefix === 'canonical' && parent.metadata.type !== 'content') throw new Error(`Non-public canonical evidence: ${chunk.id}`);
            }
        }
        if (
            metadata.recordType === 'section' &&
            (chunk.chunkIndex >= 0 || metadata.sectionIndex !== chunk.chunkIndex || chunk.text.length > AI_CONFIG.retrieval.maxSectionChars)
        ) {
            throw new Error(`Invalid parent section: ${chunk.id}`);
        }
    }
    const statuses = (status) => corpus.sources.filter((source) => source.status === status).length;
    if (
        corpus.counts.files !== corpus.sources.length ||
        corpus.counts.chunks !== corpus.chunks.length ||
        corpus.counts.includedFiles !== statuses('included') ||
        corpus.counts.draftFiles !== statuses('draft') ||
        corpus.counts.emptyFiles !== statuses('empty')
    ) {
        throw new Error('Corpus counts do not match its records');
    }
}

// ---- Canonical evidence: link curated context to the public section it supports ----
function linkCanonicalEvidence(chunks, sources, links, maxSectionChars) {
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

// ---- Section chunking ----
async function sectionChunks(identity, sections, config) {
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

export function embeddingText(chunk) {
    const labels = [chunk.metadata.title, chunk.metadata.section].filter((label) => label && label !== 'Untitled');
    return labels.length ? `${labels.join(' — ')}\n\n${chunk.text}` : chunk.text;
}

/**
 * @param {{ root?: string, embedding?: { model: string, dimensions: number }, chunking?: { chunkSize: number, chunkOverlap: number }, sourceUrls?: Map<string, string> }} [options]
 */
export async function buildCorpus({ root = process.cwd(), embedding = AI_CONFIG.embedding, chunking = CHUNK_CONFIG, sourceUrls } = {}) {
    const embeddingConfig = { model: embedding.model, dimensions: embedding.dimensions };
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
    const links = [];
    const sourceContent = new Map();
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
        corpus.sources.push({ source, hash: digest(raw), status });
        if (status !== 'included') {
            corpus.counts[status === 'draft' ? 'draftFiles' : 'emptyFiles']++;
            continue;
        }
        corpus.counts.includedFiles++;
        const url = urls.get(source);
        if (!isContext && !url) throw new Error(`Missing published Hugo URL for ${source}`);
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
    corpus.hash = corpusHash(corpus);
    corpus.namespace = namespaceFor(corpus.hash);
    corpus.chunks = corpus.chunks.map((chunk) => ({
        id: chunkId(corpus.namespace, chunk.metadata.source, chunk.chunkIndex),
        ...chunk,
    }));
    validateCorpus(corpus);
    return corpus;
}
