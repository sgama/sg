const fs = require('fs');
const path = require('path');
const glob = require('glob');
const matter = require('gray-matter');
require('dotenv').config();

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = process.env;

if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
  // If running in CI without these secrets for PRs from forks, exit gracefully?
  // But for this user repo, we expect them.
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
                        // Simple URL construction assumption - adjust for your Hugo setup
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
          await upsertVectors(batch);
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
    const response = await fetch(
         `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/vectorize/indexes/${INDEX_NAME}/insert`,
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
                "Content-Type": "application/x-ndjson" 
            },
            body: ndjson
        }
    );

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Vectorize Upsert Error: ${response.status} ${err}`);
    }
}

generateEmbeddings().catch(err => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
