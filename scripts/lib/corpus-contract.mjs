import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AI_CONFIG } from '../../functions/_lib/application.js';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
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
