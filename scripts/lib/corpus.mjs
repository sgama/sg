import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import matter from 'gray-matter';
import { ingestionText } from './content-normalization.mjs';
import { corpusHash, instanceFor, sourceHash, validateCorpus } from './corpus-contract.mjs';
import { publicSourceUrls } from './source-provenance.mjs';
import { AI_CONFIG } from '../../shared/ai/application.js';

/**
 * One AI Search item per included source file; AI Search chunks and embeds server-side.
 * @param {{ root?: string, embedding?: { model: string }, search?: { chunkSize: number, chunkOverlap: number, reranker: string }, sourceUrls?: Map<string, string> }} [options]
 */
export async function buildCorpus({ root = process.cwd(), embedding = AI_CONFIG.embedding, search = AI_CONFIG.search, sourceUrls } = {}) {
    /** @type {import('./corpus-contract.mjs').ValidatedCorpus['index']} */
    const index = {
        embeddingModel: embedding.model,
        reranker: search.reranker,
        chunkSize: search.chunkSize,
        chunkOverlap: search.chunkOverlap,
        normalizationVersion: 3,
    };
    if (typeof index.embeddingModel !== 'string' || !index.embeddingModel.trim() || typeof index.reranker !== 'string' || !index.reranker.trim()) {
        throw new Error('Invalid embedding configuration');
    }
    if (
        !Number.isInteger(index.chunkSize) ||
        index.chunkSize <= 0 ||
        !Number.isInteger(index.chunkOverlap) ||
        index.chunkOverlap < 0 ||
        index.chunkOverlap >= index.chunkSize
    ) {
        throw new Error('Invalid chunk configuration');
    }
    const files = (await glob('content/**/*.md', { cwd: root, nodir: true })).sort();
    const urls = sourceUrls ?? (await publicSourceUrls(root));
    if (!(urls instanceof Map)) throw new Error('Source provenance must be a source-to-URL map');
    /** @type {import('./corpus-contract.mjs').DraftCorpus} */
    const corpus = {
        version: 3,
        index,
        sources: [],
        items: [],
        counts: { files: files.length, includedFiles: 0, draftFiles: 0, emptyFiles: 0, items: 0 },
    };
    for (const file of files) {
        const source = file.split(path.sep).join('/');
        const raw = await readFile(path.resolve(root, file), 'utf8');
        const { data, content } = matter(raw);
        const isContext = source.startsWith('content/_context/');
        const text = data.draft ? '' : ingestionText(content, { rejectUnclosedComments: isContext });
        const status = data.draft ? 'draft' : text.trim() ? 'included' : 'empty';
        corpus.sources.push({ source, hash: sourceHash(raw), status });
        if (status !== 'included') {
            corpus.counts[status === 'draft' ? 'draftFiles' : 'emptyFiles']++;
            continue;
        }
        corpus.counts.includedFiles++;
        let url = urls.get(source);
        if (!isContext && !url) throw new Error(`Missing published Hugo URL for ${source}`);
        // Internal context may point at the public page it supports; only that page's URL is ever cited.
        if (isContext && data.retrievalSource !== undefined) {
            url = typeof data.retrievalSource === 'string' ? urls.get(data.retrievalSource) : undefined;
            if (!url) throw new Error(`Invalid retrieval source in ${source}`);
        }
        corpus.items.push({ key: source, text, metadata: { title: String(data.title || 'Untitled'), ...(url ? { url } : {}) } });
    }
    corpus.counts.items = corpus.items.length;
    const hash = corpusHash(corpus);
    const built = { ...corpus, hash, instance: instanceFor(hash) };
    validateCorpus(built);
    return built;
}
