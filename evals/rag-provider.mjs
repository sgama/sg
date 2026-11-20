// promptfoo provider: the production retrieval + generation pipeline (functions/_lib), against a live Vectorize namespace.
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { generationInput, getModel } from '../functions/_lib/application.js';
import { normalizeChatStream } from '../functions/_lib/chat-stream.js';
import { buildMessages } from '../functions/_lib/prompts.js';
import { contextFromMatches } from '../functions/_lib/retrieval.js';
import { SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext } from '../functions/_lib/validation.js';
import { createCloudflareAi } from '../scripts/lib/cloudflare-ai.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clients = new Map();

async function readAnswer(stream) {
    const events = normalizeChatStream(stream).pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream());
    let answer = '';
    for await (const { data } of events) {
        if (data === '[DONE]') continue;
        const payload = JSON.parse(data);
        if (payload.error) throw new Error(payload.error);
        answer += payload.response ?? '';
    }
    return answer;
}

export default class RagProvider {
    constructor({ config = {} } = {}) {
        /** @type {{ model?: string }} */
        this.config = config;
    }

    id() {
        return `rag:${this.config.model ?? 'glm'}`;
    }

    async callApi(_prompt, { vars }) {
        const namespace = process.env.AI_NAMESPACE;
        if (!namespace) return { error: 'Set AI_NAMESPACE (make ai-plan prints it)' };
        if (!clients.has(namespace)) clients.set(namespace, createCloudflareAi({ namespace, timeoutMs: 120000 }));
        const cloudflare = clients.get(namespace);
        const history = JSON.parse(vars.history);
        // Vectorize queries can lag a fresh ingest; retry only when a labeled case found nothing at all.
        let found;
        for (let attempt = 0; attempt < 6; attempt++) {
            found = await cloudflare.retrieve(vars.query, history);
            if (found.matches.length || vars.labeled !== 'true') break;
            await wait(5000);
        }
        const context = contextFromMatches(found.matches);
        const sources = found.matches.map((match) => match.metadata?.source).filter(Boolean);
        const model = getModel(this.config.model);
        const answer = shouldAbstainForMissingContext(context)
            ? SAFE_NO_CONTEXT_MESSAGE
            : await readAnswer(await cloudflare.run(model.id, generationInput(model, buildMessages(vars.query, context, history))));
        return { output: { answer, context, sources, retrievalQuery: found.retrievalQuery } };
    }
}
