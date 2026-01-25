const fs = require('fs');
const path = require('path');
const glob = require('glob');
const matter = require('gray-matter');
const { execSync } = require('child_process');
require('dotenv').config();

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = process.env;

if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    console.error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN");
    process.exit(1);
}

const INDEX_NAME = "portfolio-index";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

async function generateEmbeddings() {
    console.log("Starting embedding generation...");

    const files = glob.sync("content/**/*.md");
    console.log(`Found ${files.length} markdown files.`);

    const vectors = [];

    for (const file of files) {
        const rawContent = fs.readFileSync(file, 'utf8');
        const { data, content } = matter(rawContent);

        if (data.draft) continue;
        if (!content || !content.trim()) continue;

        const chunks = splitText(content, 500);

        console.log(`Processing ${file}: ${chunks.length} chunks`);

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            try {
                const embedding = await getEmbedding(chunk);

                if (embedding) {
                    // ID must be unique
                    const id = `${path.basename(file, '.md')}-${i}`;
                    vectors.push({
                        id: id,
                        values: embedding,
                        metadata: {
                            text: chunk,
                            title: data.title || "Untitled",
                            url: "/" + path.relative("content", file).replace(".md", "").replace("_index", "")
                        }
                    });
                }
            } catch (e) {
                console.error(`Error generating embedding for ${file} chunk ${i}: `, e.message);
            }
        }
    }

    if (vectors.length > 0) {
        console.log(`Upserting ${vectors.length} vectors to ${INDEX_NAME}...`);
        const BATCH_SIZE = 1000;
        for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
            const batch = vectors.slice(i, i + BATCH_SIZE);
            await upsertVectors(batch); // Now using the updated implementation
        }
        console.log("Upsert complete.");
    } else {
        console.log("No vectors to upsert.");
    }
}

function splitText(text, maxTokens = 500) {
    const maxChars = maxTokens * 4;
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

async function getEmbedding(text) {
    const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`,
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ text: [text] })
        }
    );

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`AI API Error: ${response.status} ${err}`);
    }

    const json = await response.json();
    return json.result.data[0];
}

async function upsertVectors(vectors) {
    const ndjson = vectors.map(v => JSON.stringify(v)).join("\n");
    const tempFile = path.join(__dirname, 'temp_vectors.ndjson');
    fs.writeFileSync(tempFile, ndjson);

    console.log(`Upserting batch of ${vectors.length} vectors via Wrangler CLI...`);

    try {
        // Use Wrangler CLI to handle the upsert (version management handled by tool)
        // Ensure you have ran 'npm install wrangler --save-dev'
        execSync(`npx wrangler vectorize insert ${INDEX_NAME} --file "${tempFile}"`, {
            stdio: 'inherit',
            env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID }
        });
        console.log("Batch success.");
    } catch (error) {
        console.error("Wrangler Upsert Failed:");
        throw new Error("Wrangler upsert command failed.");
    } finally {
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
    }
}

generateEmbeddings().catch(err => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
