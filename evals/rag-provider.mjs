// promptfoo provider: the production agent turn (functions/_lib/agent.js runTurn) against a live AI Search instance.
// Workers AI and AI Search are reached over REST instead of Worker bindings; the tool, prompt and event mapping are the shipped ones.
import Cloudflare from 'cloudflare';
import { createWorkersAI } from 'workers-ai-provider';
import { runTurn } from '../functions/_lib/agent.js';
import { NAMESPACE } from '../scripts/lib/corpus-deployment.mjs';

const TIMEOUT_MS = 120000;

/** @type {Map<string, Cloudflare>} */
const clients = new Map();

/** @param {string} accountId @param {string} apiToken */
function clientFor(accountId, apiToken) {
    const key = `${accountId}:${apiToken}`;
    if (!clients.has(key)) clients.set(key, new Cloudflare({ apiToken, maxRetries: 0, timeout: TIMEOUT_MS }));
    return /** @type {Cloudflare} */ (clients.get(key));
}

export default class RagProvider {
    constructor({ config = {} } = {}) {
        /** @type {{ model?: string }} */
        this.config = config;
    }

    id() {
        return `agent:${this.config.model ?? 'default'}`;
    }

    /**
     * @param {string} _prompt
     * @param {{ vars: Record<string, string> }} context
     */
    async callApi(_prompt, { vars }) {
        const { AI_INSTANCE: instance, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiKey } = process.env;
        if (!instance) return { error: 'Set AI_INSTANCE (make ai-plan prints it)' };
        if (!accountId || !apiKey) return { error: 'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN' };
        const client = clientFor(accountId, apiKey);
        const workersAI = createWorkersAI({ accountId, apiKey });
        /** @type {string[]} */
        const queries = [];
        /** @type {{ text: string, key?: string }[]} */
        const retrieved = [];
        const recorder = {
            /** @param {{ query: string }} params */
            async search(params) {
                queries.push(params.query);
                const found = await client.aiSearch.namespaces.instances.search(instance, { account_id: accountId, name: NAMESPACE, ...params });
                retrieved.push(...found.chunks.map((chunk) => ({ text: chunk.text, key: chunk.item?.key })));
                return found;
            },
        };
        let answer = '';
        /** @type {{ url: string }[]} */
        let evidence = [];
        try {
            const events = runTurn({
                env: /** @type {any} */ ({ AI_MODEL: this.config.model }),
                query: vars.query,
                history: JSON.parse(vars.history),
                signal: AbortSignal.timeout(TIMEOUT_MS),
                languageModel: (model) => workersAI(model.id, model.parameters),
                instance: /** @type {any} */ (recorder),
            });
            for await (const event of events) {
                if ('response' in event) answer += event.response;
                if ('evidence' in event) evidence = /** @type {any} */ (event.evidence);
            }
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
        return {
            output: {
                answer,
                queries,
                searched: queries.length > 0,
                sources: [...new Set(retrieved.map((chunk) => chunk.key).filter(Boolean))],
                context: retrieved.map((chunk) => chunk.text).join('\n'),
                urls: evidence.map((item) => item.url),
            },
        };
    }
}
