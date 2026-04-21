const fs = require('fs');
const path = require('path');
const glob = require('glob');
const matter = require('gray-matter');
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
 * Run embedding generation with concurrency limit
 * Replaces sequential loop with a Promise.all + semaphore pattern
 */
async function generateEmbeddingsInParallel(chunks, concurrency) {
    const results = [];
    const queue = [...chunks];

    // Simple pool implementation
    // Ideally use 'p-limit' library, but keeping deps minimal
    const next = async () => {
        if (queue.length === 0) return;
        const chunk = queue.shift();

        try {
            const embedding = await getEmbeddingWithRetry(chunk.text);
            results.push({
                id: chunk.id,
                values: embedding,
                metadata: chunk.metadata
            });
            process.stdout.write("."); // Progress indicator
        } catch (err) {
            console.error(`\nFailed to embed chunk ${chunk.id}: ${err.message}`);
        }

        await next();
    };

    const initialWorkers = [];
    for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
        initialWorkers.push(next());
    }

    await Promise.all(initialWorkers);
    console.log("\nEmbedding complete.");
    return results;
}

/**
 * Call Workers AI API
 */
async function getEmbeddingWithRetry(text, retries = 3) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CONFIG.EMBEDDING_MODEL}`;

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ text: [text] })
            });

            if (!response.ok) {
                // Rate limiting handling could go here
                throw new Error(`API ${response.status}: ${await response.text()}`);
            }

            const json = await response.json();
            return json.result.data[0];
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 1000 * (i + 1))); // Exponential backoffish
        }
    }
}

/**
 * Upsert to Vectorize via REST API (Cleaner than Wrangler CLI)
 */
async function batchUpsertVectors(vectors) {
    // Note: This requires the Index ID, using Index Name via API requires a lookup first.
    // For simplicity, sticking to the Wrangler CLI wrapper but making it more robust,
    // OR we would need to fetch the index list to get the ID for 'portfolio-index'.
    // Given the difficulty of finding the underlying ID without an extra call,
    // we will optimize the implementation for REST API if we assume user knows ID,
    // otherwise fallback to a more robust CLI call.

    // However, to make this "Enterprise Ready", relying on "wrangler" being in PATH is shaky.
    // The previous implementation used `ndjson` + `wrangler vectorize insert`.
    // Let's improve that by handling the batching loop properly here.

    const { execSync } = require('child_process');
    const BATCH_SIZE = CONFIG.UPSERT_BATCH_SIZE;

    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
        const batch = vectors.slice(i, i + BATCH_SIZE);
        const ndjson = batch.map(v => JSON.stringify(v)).join("\n");
        const tempFile = path.join(__dirname, `temp_vectors_${Date.now()}.ndjson`);

        try {
            fs.writeFileSync(tempFile, ndjson);
            // Use npx to ensure local version is used
            execSync(`npx wrangler vectorize insert ${CONFIG.INDEX_NAME} --file "${tempFile}"`, {
                stdio: 'ignore', // Suppress noisy output
                env: { ...process.env } // Pass through env vars
            });
            console.log(`   ✅ Batch ${i / BATCH_SIZE + 1} uploaded (${batch.length} vectors)`);
        } catch (err) {
            console.error(`   ❌ Batch upload failed: ${err.message}`);
            // In enterprise scenario: push to a Dead Letter Queue or log to file
        } finally {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        }
    }
}

// Ensure strict run if execution
if (require.main === module) {
    main();
}

// Export for Testing
module.exports = { splitText, processFile, main };
