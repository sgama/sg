import { CONFIG } from './config.js';

export class AiService {
    constructor(env) {
        this.ai = env.AI;
        this.vectorize = env.VECTORIZE_INDEX;
    }

    async getEmbeddings(text) {
        try {
            const { data } = await this.ai.run(CONFIG.MODELS.EMBEDDINGS, { text: [text] });
            return data[0];
        } catch (err) {
            console.error('Embedding Generation Failed:', err);
            return null;
        }
    }

    async retrieveContext(query) {
        if (!this.vectorize) return "";

        const vector = await this.getEmbeddings(query);
        if (!vector) return "";

        try {
            const results = await this.vectorize.query(vector, {
                topK: CONFIG.VECTOR_SEARCH.FINAL_K,
                returnMetadata: 'all'
            });
            return (results.matches || [])
                .map(m => m.metadata?.text || "")
                .filter(text => text.length > 0)
                .join("\n---\n");
        } catch (err) {
            console.error('Vector Search Failed:', err);
            return "";
        }
    }

    async generateStream(query, contextText, history = []) {
        const messages = [
            { role: "system", content: `${CONFIG.SYSTEM_PROMPT}\n\nContext:\n${contextText}` },
            ...history,
            { role: "user", content: query }
        ];
        return await this.ai.run(CONFIG.MODELS.GENERATION, { messages, stream: true });
    }
}
