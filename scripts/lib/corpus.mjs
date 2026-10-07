import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import matter from 'gray-matter';
import { MarkdownTextSplitter } from '@langchain/textsplitters';
import { AI_CONFIG } from '../../functions/_lib/application.js';

export const CHUNK_CONFIG = Object.freeze({ chunkSize: 2000, chunkOverlap: 200 });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const namespaceFor = (hash) => `corpus-${hash.slice(0, 56)}`;
const chunkId = (namespace, source, index) => digest(`${namespace}\0${source}\0${index}`);

function corpusHash(corpus) {
    return digest(JSON.stringify({
        version: corpus.version,
        embedding: corpus.embedding,
        chunking: corpus.chunking,
        sources: corpus.sources,
        chunks: corpus.chunks.map(({ chunkIndex, text, metadata }) => ({ chunkIndex, text, metadata })),
    }));
}

export function validateCorpus(corpus) {
    const ids = new Set();
    for (const chunk of corpus.chunks) {
        if (ids.has(chunk.id)) throw new Error(`Duplicate chunk ID: ${chunk.id}`);
        ids.add(chunk.id);
    }
    if (corpusHash(corpus) !== corpus.hash || namespaceFor(corpus.hash) !== corpus.namespace) {
        throw new Error('Corpus hash or namespace does not match its contents');
    }
    for (const chunk of corpus.chunks) {
        if (chunk.id !== chunkId(corpus.namespace, chunk.metadata.source, chunk.chunkIndex)) {
            throw new Error(`Invalid chunk ID: ${chunk.id}`);
        }
    }
    if (!Number.isInteger(corpus.embedding.dimensions) || corpus.embedding.dimensions <= 0) {
        throw new Error('Embedding dimensions must be a positive integer');
    }
}

export async function buildCorpus({
    root = process.cwd(),
    embedding = AI_CONFIG.embedding,
    chunking = CHUNK_CONFIG,
} = {}) {
    const embeddingConfig = { model: embedding.model, dimensions: embedding.dimensions };
    const chunkConfig = { chunkSize: chunking.chunkSize, chunkOverlap: chunking.chunkOverlap };
    if (typeof embeddingConfig.model !== 'string' || !embeddingConfig.model.trim()
        || !Number.isInteger(embeddingConfig.dimensions) || embeddingConfig.dimensions <= 0) {
        throw new Error('Invalid embedding configuration');
    }
    if (!Number.isInteger(chunkConfig.chunkSize) || chunkConfig.chunkSize <= 0
        || !Number.isInteger(chunkConfig.chunkOverlap) || chunkConfig.chunkOverlap < 0
        || chunkConfig.chunkOverlap >= chunkConfig.chunkSize) {
        throw new Error('Invalid chunk configuration');
    }
    // The existing character-based splitter is retained; characters do not guarantee a token bound.
    const splitter = new MarkdownTextSplitter(chunkConfig);
    const files = (await glob('content/**/*.md', { cwd: root, nodir: true })).sort();
    const corpus = {
        version: 1,
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
        const status = data.draft ? 'draft' : content.trim() ? 'included' : 'empty';
        corpus.sources.push({ source, hash: digest(raw), status });
        if (status !== 'included') {
            corpus.counts[status === 'draft' ? 'draftFiles' : 'emptyFiles']++;
            continue;
        }
        corpus.counts.includedFiles++;
        const isContext = source.startsWith('content/_context/');
        const url = '/' + source.slice('content/'.length)
            .replace(/\.md$/, '').replace(/(^|\/)_?index$/, '');
        const segments = await splitter.splitText(content);
        segments.forEach((text, chunkIndex) => {
            corpus.chunks.push({
                chunkIndex,
                text,
                metadata: {
                    source,
                    type: isContext ? 'context' : 'content',
                    title: String(data.title || 'Untitled'),
                    text,
                    ...(isContext ? {} : { url: url || '/' }),
                },
            });
        });
    }
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
