import { AI_CONFIG, AppError, buildMessages, getModel, generationInput, contextFromMatches } from './config.js';
import { normalizeChatStream } from './chat-stream.js';

export class AiService {
    constructor(env) {
        this.ai = env.AI;
        this.vectorize = env.VECTORIZE_INDEX;
        this.namespace = env.AI_CORPUS_NAMESPACE;
        this.model = getModel(env.AI_MODEL);
    }

    async getEmbeddings(text) {
        try {
            const { data } = await this.ai.run(AI_CONFIG.embedding.model, { text: [text] });
            const vector = data?.[0];
            if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) {
                throw new Error('Invalid embedding response');
            }
            return vector;
        } catch (err) {
            console.error('Embedding Generation Failed:', err);
            throw new AppError('Embedding service unavailable', 503);
        }
    }

    async retrieveContext(query) {
        if (!this.vectorize) {
            console.error('Vector Search Failed: VECTORIZE_INDEX binding missing');
            throw new AppError('Retrieval service unavailable', 503);
        }

        const vector = await this.getEmbeddings(query);

        try {
            const results = await this.vectorize.query(vector, {
                topK: AI_CONFIG.retrieval.topK,
                returnMetadata: 'all',
                ...(this.namespace ? { namespace: this.namespace } : {}),
            });
            if (!Array.isArray(results.matches)) throw new Error('Invalid Vectorize response');
            return contextFromMatches(results.matches);
        } catch (err) {
            console.error('Vector Search Failed:', err);
            throw new AppError('Retrieval service unavailable', 503);
        }
    }

    async generateStream(query, contextText, history = []) {
        const messages = buildMessages(query, contextText, history);
        try {
            const stream = await this.ai.run(this.model.id, generationInput(this.model, messages));
            return normalizeChatStream(stream);
        } catch (err) {
            console.error('Generation Failed:', err);
            throw new AppError('Generation service unavailable', 503);
        }
    }
}
