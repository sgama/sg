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

export function sourceSections(content) {
    const sections = [];
    let lines = [];
    let heading = '';
    let fence = null;
    for (const line of content.split(/\r?\n/)) {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (marker) {
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        }
        const boundary = !fence && !marker && line.match(/^#{1,2}[ \t]+(.+?)[ \t]*#*[ \t]*$/);
        if (boundary) {
            if (lines.join('\n').trim()) sections.push({ heading, text: lines.join('\n').trim() });
            lines = [];
            heading = boundary[1];
        }
        lines.push(line);
    }
    if (lines.join('\n').trim()) sections.push({ heading, text: lines.join('\n').trim() });
    return sections;
}

function corpusHash(corpus) {
    return digest(
        JSON.stringify({
            version: corpus.version,
            embedding: corpus.embedding,
            chunking: corpus.chunking,
            sources: corpus.sources,
            chunks: corpus.chunks.map(({ chunkIndex, text, metadata }) => ({
                chunkIndex,
                text,
                metadata,
            })),
        }),
    );
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
        if (Number.isInteger(chunk.metadata.parentIndex)) {
            const parent = corpus.chunks.find(
                (item) => item.metadata.source === chunk.metadata.source && item.chunkIndex === chunk.metadata.parentIndex,
            );
            if (!parent || parent.metadata.recordType !== 'section') throw new Error(`Missing parent section: ${chunk.id}`);
        }
        if (
            chunk.metadata.recordType === 'section' &&
            (chunk.chunkIndex >= 0 || chunk.metadata.sectionIndex !== chunk.chunkIndex || chunk.text.length > AI_CONFIG.retrieval.maxSectionChars)
        ) {
            throw new Error(`Invalid parent section: ${chunk.id}`);
        }
    }
    if (!Number.isInteger(corpus.embedding.dimensions) || corpus.embedding.dimensions <= 0) {
        throw new Error('Embedding dimensions must be a positive integer');
    }
}

export async function buildCorpus({ root = process.cwd(), embedding = AI_CONFIG.embedding, chunking = CHUNK_CONFIG } = {}) {
    const embeddingConfig = { model: embedding.model, dimensions: embedding.dimensions };
    const chunkConfig = { chunkSize: chunking.chunkSize, chunkOverlap: chunking.chunkOverlap, maxSectionChars: AI_CONFIG.retrieval.maxSectionChars };
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
    // The existing character-based splitter is retained; characters do not guarantee a token bound.
    const splitter = new MarkdownTextSplitter(chunkConfig);
    const sectionSplitter = new MarkdownTextSplitter({ chunkSize: chunkConfig.maxSectionChars, chunkOverlap: chunkConfig.chunkOverlap });
    const files = (await glob('content/**/*.md', { cwd: root, nodir: true })).sort();
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
        let indexContent = content;
        if (isContext) {
            indexContent = content.replace(/<!--[\s\S]*?-->/g, '');
            if (indexContent.includes('<!--')) throw new Error(`Unclosed authoring comment in ${source}`);
        }
        const status = data.draft ? 'draft' : indexContent.trim() ? 'included' : 'empty';
        corpus.sources.push({ source, hash: digest(raw), status });
        if (status !== 'included') {
            corpus.counts[status === 'draft' ? 'draftFiles' : 'emptyFiles']++;
            continue;
        }
        corpus.counts.includedFiles++;
        const url =
            '/' +
            source
                .slice('content/'.length)
                .replace(/\.md$/, '')
                .replace(/(^|\/)_?index$/, '');
        const identity = {
            source,
            type: isContext ? 'context' : 'content',
            title: String(data.title || 'Untitled'),
            ...(isContext ? {} : { url: url || '/' }),
        };
        let chunkIndex = 0;
        let sectionIndex = -1;
        for (const section of sourceSections(indexContent)) {
            const parents = await sectionSplitter.splitText(section.text);
            for (const text of parents) {
                const segments = await splitter.splitText(text);
                const parentIndex = segments.length > 1 ? sectionIndex-- : null;
                if (parentIndex !== null) {
                    corpus.chunks.push({
                        chunkIndex: parentIndex,
                        text,
                        metadata: { ...identity, section: section.heading, recordType: 'section', sectionIndex: parentIndex, text },
                    });
                }
                for (const segment of segments) {
                    corpus.chunks.push({
                        chunkIndex: chunkIndex++,
                        text: segment,
                        metadata: {
                            ...identity,
                            section: section.heading,
                            ...(parentIndex !== null ? { parentIndex } : {}),
                            text: segment,
                        },
                    });
                }
            }
        }
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
