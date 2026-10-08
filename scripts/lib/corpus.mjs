import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import matter from 'gray-matter';
import { ingestionText, sourceSections } from './content-normalization.mjs';
import { publicSourceUrls } from './source-provenance.mjs';
import { digest, namespaceFor, chunkId, corpusHash, validateCorpus } from './corpus-contract.mjs';
import { linkCanonicalEvidence } from './canonical-evidence.mjs';
import { sectionChunks } from './section-chunks.mjs';
import { AI_CONFIG } from '../../functions/_lib/application.js';
export { ingestionText, sourceSections } from './content-normalization.mjs';
export { validateCorpus } from './corpus-contract.mjs';

export const CHUNK_CONFIG = Object.freeze({ chunkSize: 2000, chunkOverlap: 200 });

export function embeddingText(chunk) {
    const labels = [chunk.metadata.title, chunk.metadata.section].filter((label) => label && label !== 'Untitled');
    return labels.length ? `${labels.join(' — ')}\n\n${chunk.text}` : chunk.text;
}

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
