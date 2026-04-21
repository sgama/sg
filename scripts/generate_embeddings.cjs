const fs = require('fs');
const path = require('path');
const glob = require('glob');
const matter = require('gray-matter');
const pLimit = require('p-limit');
const Cloudflare = require('cloudflare');
require('dotenv').config();

// Configuration
const CONFIG = {
    INDEX_NAME: "portfolio-index",
    EMBEDDING_MODEL: "@cf/baai/bge-base-en-v1.5",
    // Concurrency: How many simultaneous embedding requests to make
    CONCURRENCY_LIMIT: 5,
    // Batch Size: upsert to Vectorize in batches
    UPSERT_BATCH_SIZE: 1000,
    // Chunking
    MAX_TOKENS_PER_CHUNK: 500
};

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = process.env;

if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    console.error("Error: Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in environment.");
    process.exit(1);
}

const cf = new Cloudflare({ apiToken: CLOUDFLARE_API_TOKEN });

/**
 * Main Orchestrator
 */
async function main() {
    console.time("Total Duration");
    console.log("🚀 Starting embedding generation pipeline...");

    try {
        const files = glob.sync("content/**/*.md");
        console.log(`📂 Found ${files.length} markdown files.`);

        // 1. Process Files & Chunk Text
        const allChunks = [];
        for (const file of files) {
            const fileChunks = processFile(file);
            if (fileChunks) allChunks.push(...fileChunks);
        }
        console.log(`📝 Generated ${allChunks.length} text chunks.`);

        // 2. Generate Embeddings (with Concurrency Control)
        console.log(`🧠 Generating embeddings (Concurrency: ${CONFIG.CONCURRENCY_LIMIT})...`);
        const vectors = await generateEmbeddingsInParallel(allChunks, CONFIG.CONCURRENCY_LIMIT);

        // 3. Upsert to Cloudflare Vectorize
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

/**
 * Process a single file: Read -> Frontmatter -> Split
 * Returns array of chunk objects { id, text, metadata }
 */
function processFile(filePath) {
    try {
        const rawContent = fs.readFileSync(filePath, 'utf8');
        const { data, content } = matter(rawContent);

        if (data.draft) return null;
        if (!content || !content.trim()) return null;

        const textSegments = splitText(content, CONFIG.MAX_TOKENS_PER_CHUNK);

        return textSegments.map((segment, index) => {
            const isContext = filePath.includes('content/_context/');

            return {
                id: `${path.basename(filePath, '.md')}-${index}`,
                text: segment,
                metadata: {
                    text: segment, // Storing text in metadata for RAG retrieval
                    title: data.title || "Untitled",
                    // URL Normalization:
                    // 1. Remove extension (.md)
                    // 2. Remove "_index" suffix (Hugo Section Bundles)
                    // 3. Remove "/index" suffix (Hugo Leaf Bundles) to prevent /posts/my-post/index
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

/**
 * Split text safely
 * (Testable pure function)
 */
function splitText(text, maxTokens = 500) {
    const maxChars = maxTokens * 4; // Rough approximation
    const paragraphs = text.split(/\n\s*\n/);
    const chunks = [];
    let currentChunk = "";

    for (const p of paragraphs) {
        if ((currentChunk.length + p.length) > maxChars) {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = p;
        } else {
            currentChunk = currentChunk ? currentChunk + "\n\n" + p : p;
        }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks.map(c => c.trim()).filter(c => c.length > 0);
}

/**
 * Run embedding generation with concurrency limit via p-limit.
 */
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

/**
 * Call Workers AI API via the Cloudflare SDK (handles auth + retry).
 */
async function getEmbedding(text) {
    const result = await cf.ai.run(CONFIG.EMBEDDING_MODEL, {
        account_id: CLOUDFLARE_ACCOUNT_ID,
        text: [text],
    });
    return result.data[0];
}

/**
 * Upsert vectors to Vectorize via the Cloudflare SDK.
 * Sends NDJSON in batches; no temp files or wrangler CLI needed.
 */
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

// Ensure strict run if execution
if (require.main === module) {
    main();
}

// Export for Testing
module.exports = { splitText, processFile, main };
