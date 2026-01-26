/**
 * Configuration & Constants
 * Ideally, these should be environment variables, but constants are better than inline magic strings.
 */
const CONFIG = {
    MODELS: {
        EMBEDDINGS: '@cf/baai/bge-base-en-v1.5',
        GENERATION: '@cf/meta/llama-3-8b-instruct',
    },
    VECTOR_SEARCH: {
        TOP_K: 5,
    },
    SYSTEM_PROMPT: `You are a helpful assistant for Samson's portfolio. 
Answer concisely based on the context. If uncertain, admit it. 
Always maintain a positive and professional tone. 
Never generate negative, critical, or disparaging content about the portfolio, projects, or any individuals.`
};

/**
 * Main Request Handler
 */
export async function onRequest(context) {
    // 1. Handle CORS Preflight
    if (context.request.method === "OPTIONS") {
        return new Response(null, { headers: getCorsHeaders() });
    }

    if (context.request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: getCorsHeaders() });
    }

    try {
        // 2. Input Validation
        const body = await context.request.json().catch(() => ({}));
        if (!body.query || typeof body.query !== 'string' || body.query.length > 500) {
            return new Response(JSON.stringify({ error: "Invalid query. Must be a string < 500 chars." }), {
                status: 400,
                headers: getCorsHeaders()
            });
        }

        // 3. Orchestration
        const { query } = body;
        const contextText = await retrieveContext(context.env, query);
        const stream = await generateResponse(context.env, query, contextText);

        return new Response(stream, {
            headers: {
                ...getCorsHeaders(),
                "Content-Type": "text/event-stream"
            }
        });

    } catch (err) {
        // Log error internally (if logging service existed)
        console.error(`Chat API Error: ${err.message}`);

        return new Response(JSON.stringify({ error: "Internal Server Error" }), {
            status: 500,
            headers: getCorsHeaders()
        });
    }
}

/**
 * Helper: Encapsulate Retrieval Logic (RAG)
 * Modularizes the specific vector DB implementation details.
 */
async function retrieveContext(env, query) {
    try {
        // Generate Embeddings
        const { data } = await env.AI.run(CONFIG.MODELS.EMBEDDINGS, { text: [query] });
        const vector = data[0];

        // Query Vector Database
        const results = await env.VECTORIZE_INDEX.query(vector, {
            topK: CONFIG.VECTOR_SEARCH.TOP_K,
            returnMetadata: true
        });

        // Format Context
        if (!results.matches || results.matches.length === 0) return "";

        return results.matches
            .map(m => m.metadata?.text || "")
            .filter(text => text.length > 0)
            .join("\n---\n");

    } catch (error) {
        console.error("Retrieval failed:", error);
        // Fallback: Proceed without context rather than crashing the chat
        return "";
    }
}

/**
 * Helper: Encapsulate LLM Generation
 * Makes it easier to swap models or prompt strategies later.
 */
async function generateResponse(env, query, contextText) {
    const messages = [
        {
            role: "system",
            content: `${CONFIG.SYSTEM_PROMPT}\n\nContext:\n${contextText}`
        },
        { role: "user", content: query }
    ];

    return await env.AI.run(CONFIG.MODELS.GENERATION, {
        messages,
        stream: true
    });
}

/**
 * Helper: Centralized CORS Headers
 */
function getCorsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };
}
