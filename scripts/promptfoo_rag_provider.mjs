import Cloudflare from 'cloudflare';
import 'dotenv/config';

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const INDEX_NAME = 'portfolio-index';
const TOP_K = 3;

export default {
    id() { return 'vectorize-rag'; },

    async callApi(prompt) {
        const cf = new Cloudflare({ apiToken: process.env.CLOUDFLARE_API_TOKEN });
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

        const embResult = await cf.ai.run(EMBEDDING_MODEL, {
            account_id: accountId,
            text: [prompt],
        });
        const vector = embResult.data[0];

        const searchResult = await cf.vectorize.indexes.query(INDEX_NAME, {
            account_id: accountId,
            vector,
            topK: TOP_K,
            returnMetadata: 'all',
        });

        const output = (searchResult.matches || [])
            .map(m => m.metadata?.text || '')
            .filter(Boolean)
            .join('\n---\n');

        return { output };
    },
};
