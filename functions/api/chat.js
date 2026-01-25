export async function onRequest(context) {
  if (context.request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (context.request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { query } = await context.request.json();
    
    // 1. Retrieval
    const { data } = await context.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [query] });
    const values = data[0];
    const results = await context.env.VECTORIZE_INDEX.query(values, { topK: 5, returnMetadata: true });
    const contextBlock = results.matches 
      ? results.matches.map(m => m.metadata?.text || "").join("\n---\n")
      : "";

    // 2. Generation with Streaming
    const systemPrompt = "You are a helpful assistant for Samson's portfolio. " + 
                         "Answer concisely based on the context. If uncertain, admit it.";
                         
    const messages = [
      { role: "system", content: systemPrompt + "\n\nContext:\n" + contextBlock },
      { role: "user", content: query }
    ];
    
    // Enabling streaming via Workers AI
    const stream = await context.env.AI.run('@cf/meta/llama-3-8b-instruct', { 
      messages,
      stream: true
    });
    
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
