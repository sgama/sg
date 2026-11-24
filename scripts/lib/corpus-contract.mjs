import { createHash } from 'node:crypto';
import { z } from 'zod';

// ---- Contract: identity, hashing and schema validation of a corpus ----
/** @param {string} value */
const digest = (value) => createHash('sha256').update(value).digest('hex');
export const sourceHash = digest;
export const VERSIONED_INSTANCE = /^portfolio-[a-f0-9]{12}$/;
/** @param {string} hash */
export const instanceFor = (hash) => `portfolio-${hash.slice(0, 12)}`;

/** Instance creation settings that do not come from config. They are hashed, so changing one yields a new instance. */
export const INSTANCE_SETTINGS = {
    index_method: { vector: true, keyword: true },
    fusion_method: /** @type {const} */ ('rrf'),
    reranking: true,
    chunk: true,
    cache: true,
    custom_metadata: [
        { field_name: 'title', data_type: /** @type {const} */ ('text') },
        { field_name: 'url', data_type: /** @type {const} */ ('text') },
    ],
};

const nonempty = z.string().trim().min(1);
const schema = z.object({
    version: z.literal(3),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    instance: z.string().regex(VERSIONED_INSTANCE),
    index: z.object({
        embeddingModel: nonempty,
        reranker: nonempty,
        chunkSize: z.number().int().positive(),
        chunkOverlap: z.number().int().nonnegative(),
        normalizationVersion: z.literal(3),
    }),
    sources: z.array(z.object({ source: nonempty, hash: nonempty, status: z.enum(['included', 'draft', 'empty']) })),
    items: z.array(
        z.object({
            key: z
                .string()
                .max(128)
                .regex(/^[A-Za-z0-9._/-]+$/),
            text: nonempty,
            metadata: z.object({ title: nonempty, url: z.string().optional() }),
        }),
    ),
    counts: z.object({
        files: z.number().int().nonnegative(),
        includedFiles: z.number().int().nonnegative(),
        draftFiles: z.number().int().nonnegative(),
        emptyFiles: z.number().int().nonnegative(),
        items: z.number().int().nonnegative(),
    }),
});
/** @typedef {z.infer<typeof schema>} ValidatedCorpus */
/** @typedef {Omit<ValidatedCorpus, 'hash' | 'instance'>} DraftCorpus */

/** @param {DraftCorpus} corpus */
export function corpusHash(corpus) {
    return digest(
        JSON.stringify({ version: corpus.version, index: corpus.index, settings: INSTANCE_SETTINGS, sources: corpus.sources, items: corpus.items }),
    );
}

/** @param {ValidatedCorpus} corpus */
export function validateCorpus(corpus) {
    schema.parse(corpus);
    const included = new Set(corpus.sources.filter((source) => source.status === 'included').map((source) => source.source));
    if (new Set(corpus.sources.map((source) => source.source)).size !== corpus.sources.length) throw new Error('Duplicate corpus source');
    if (new Set(corpus.items.map((item) => item.key)).size !== corpus.items.length) throw new Error('Duplicate corpus item key');
    if (corpusHash(corpus) !== corpus.hash || instanceFor(corpus.hash) !== corpus.instance)
        throw new Error('Corpus hash or instance does not match its contents');
    for (const { key, metadata } of corpus.items) {
        if (!included.has(key)) throw new Error(`Item source is not included: ${key}`);
        const internal = key.startsWith('content/_context/');
        const { url } = metadata;
        if (!internal && !url) throw new Error(`Public item is missing its URL: ${key}`);
        if (url && (!/^\/(?!\/)/.test(url) || /[\\\r\n]/.test(url) || /^\/_context(\/|$)/.test(url)))
            throw new Error(`Invalid public item URL: ${key}`);
    }
    const statuses = (/** @type {string} */ status) => corpus.sources.filter((source) => source.status === status).length;
    if (
        corpus.items.length !== included.size ||
        corpus.counts.files !== corpus.sources.length ||
        corpus.counts.items !== corpus.items.length ||
        corpus.counts.includedFiles !== statuses('included') ||
        corpus.counts.draftFiles !== statuses('draft') ||
        corpus.counts.emptyFiles !== statuses('empty')
    ) {
        throw new Error('Corpus counts do not match its records');
    }
}
