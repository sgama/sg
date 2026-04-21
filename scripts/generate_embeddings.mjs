import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import matter from 'gray-matter';
import pLimit from 'p-limit';
import Cloudflare from 'cloudflare';
import { MarkdownTextSplitter } from '@langchain/textsplitters';
import 'dotenv/config';

const CONFIG = {
    INDEX_NAME: "portfolio-index",
    EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5",
    CONCURRENCY_LIMIT: 5,
    UPSERT_BATCH_SIZE: 1000,
};

const splitter = new MarkdownTextSplitter({
    chunkSize: 2000,   // ~500 tokens at 4 chars/token, matching BGE base's 512-token limit
    chunkOverlap: 200, // overlap preserves context across chunk boundaries
});

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = process.env;

if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    console.error("Error: Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in environment.");
    process.exit(1);
}

const cf = new Cloudflare({ apiToken: CLOUDFLARE_API_TOKEN });

async function main() {
    console.time("Total Duration");
    console.log("🚀 Starting embedding generation pipeline...");

    try {
        const files = await glob("content/**/*.md");
        console.log(`📂 Found ${files.length} markdown files.`);

        const allChunks = [];
        for (const file of files) {
            const fileChunks = await processFile(file);
            if (fileChunks) allChunks.push(...fileChunks);
        }
        console.log(`📝 Generated ${allChunks.length} text chunks.`);

        console.log(`🧠 Generating embeddings (Concurrency: ${CONFIG.CONCURRENCY_LIMIT})...`);
        const vectors = await generateEmbeddingsInParallel(allChunks, CONFIG.CONCURRENCY_LIMIT);

        if (vectors.length > 0) {
            console.log(`☁️  Upserting ${vectors.length} vectors to index: ${CONFIG.INDEX_NAME}`);
            await batchUpsertVectors(vectors);
        } else {
            console.warn("⚠️  No vectors generated. Skipping upsert.");
        }

    } catch (error) {
        console.error("❌ Fatal Pipeline Error:", error);
        process.exit(1);
    } finally {
        console.timeEnd("Total Duration");
    }
}

export async function processFile(filePath) {
    try {
        const rawContent = fs.readFileSync(filePath, 'utf8');
        const { data, content } = matter(rawContent);

        if (data.draft) return null;
        if (!content || !content.trim()) return null;

        const textSegments = await splitter.splitText(content);

        return textSegments.map((segment, index) => {
            const isContext = filePath.includes('content/_context/');
            return {
                id: `${path.basename(filePath, '.md')}-${index}`,
                text: segment,
                metadata: {
                    text: segment,
                    title: data.title || "Untitled",
                    url: isContext ? null : "/" + path.relative("content", filePath)
                        .replace(/\.md$/, "")
                        .replace(/_index$/, "")
                        .replace(/\/index$/, ""),
                    type: isContext ? 'context' : 'content'
                }
            };
        });
    } catch (err) {
        console.error(`Error processing file ${filePath}: ${err.message}`);
        return null;
    }
}


async function generateEmbeddingsInParallel(chunks, concurrency) {
    const limit = pLimit(concurrency);
    const results = [];

    await Promise.all(chunks.map(chunk =>
        limit(async () => {
            try {
                const embedding = await getEmbedding(chunk.text);
                results.push({ id: chunk.id, values: embedding, metadata: chunk.metadata });
                process.stdout.write(".");
            } catch (err) {
                console.error(`\nFailed to embed chunk ${chunk.id}: ${err.message}`);
            }
        })
    ));

    console.log("\nEmbedding complete.");
    return results;
}

async function getEmbedding(text) {
    const result = await cf.ai.run(CONFIG.EMBEDDING_MODEL, {
        account_id: CLOUDFLARE_ACCOUNT_ID,
        text: [text],
    });
    return result.data[0];
}

async function batchUpsertVectors(vectors) {
    const BATCH_SIZE = CONFIG.UPSERT_BATCH_SIZE;

    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
        const batch = vectors.slice(i, i + BATCH_SIZE);
        const ndjson = batch.map(v => JSON.stringify(v)).join('\n');

        try {
            await cf.vectorize.indexes.upsert(CONFIG.INDEX_NAME, {
                account_id: CLOUDFLARE_ACCOUNT_ID,
                body: ndjson,
            });
            console.log(`   ✅ Batch ${Math.floor(i / BATCH_SIZE) + 1} uploaded (${batch.length} vectors)`);
        } catch (err) {
            console.error(`   ❌ Batch upload failed: ${err.message}`);
        }
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
