import { AI_CONFIG, expandSectionMatches } from '../../functions/_lib/application.js';

export function normalizeVector(vector, dimensions) {
    if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every(Number.isFinite)) {
        throw new Error('Invalid local embedding dimensions or values');
    }
    const length = Math.hypot(...vector);
    if (!length) throw new Error('Local embedding has zero magnitude');
    return vector.map((value) => value / length);
}

export function searchVectors(chunks, vectors, query, topK = AI_CONFIG.retrieval.topK) {
    if (chunks.length !== vectors.length) throw new Error('Incomplete local vector index');
    const matches = chunks
        .map((chunk, index) => ({
            id: chunk.id,
            metadata: chunk.metadata,
            score: vectors[index].reduce((sum, value, dimension) => sum + value * query[dimension], 0),
        }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, topK);
    const sections = chunks.filter((chunk) => chunk.metadata.recordType === 'section').map((chunk) => ({ id: chunk.id, metadata: chunk.metadata }));
    return expandSectionMatches(matches, sections);
}

export function createLocalAi({ url, embeddingModel, dimensions, timeoutMs, contextTokens = 4096, embeddingBackend = 'ollama', fetchImpl = fetch }) {
    const base = new URL(url);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
        throw new Error('Local AI requires a loopback HTTP endpoint');
    }
    const request = async (route, body) => {
        const response = await fetchImpl(new URL(route, base), {
            method: body ? 'POST' : 'GET',
            ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 1000);
            throw new Error(`Local AI ${route} returned HTTP ${response.status}: ${detail}`);
        }
        return response;
    };
    return {
        async embed(text, task = 'document') {
            if (embeddingBackend === 'tei') {
                const vectors = await (
                    await request('/embed', {
                        inputs: text,
                        truncate: true,
                        normalize: true,
                    })
                ).json();
                if (!Array.isArray(vectors) || vectors.length !== text.length) {
                    throw new Error('Incomplete local embeddings');
                }
                return vectors.map((vector) => normalizeVector(vector, dimensions));
            }
            const input = embeddingModel.split(':')[0] === 'nomic-embed-text' ? text.map((value) => `search_${task}: ${value}`) : text;
            const result = await (
                await request('/api/embed', {
                    model: embeddingModel,
                    input,
                    truncate: false,
                    options: { num_gpu: -1 },
                    keep_alive: '5m',
                })
            ).json();
            if (!Array.isArray(result.embeddings) || result.embeddings.length !== text.length) {
                throw new Error('Incomplete local embeddings');
            }
            return result.embeddings.map((vector) => normalizeVector(vector, dimensions));
        },
        async gpuEvidence(model) {
            if (embeddingBackend === 'tei') {
                const info = await (await request('/info')).json();
                if (info.model_id !== embeddingModel) throw new Error('Unexpected TEI embedding model');
                return { model: info.model_id, info };
            }
            const { models } = await (await request('/api/ps')).json();
            const loaded = models?.find((item) => item.name === model || item.name === `${model}:latest`);
            if (!loaded || !(loaded.size_vram > 0)) throw new Error(`Model ${model} is not using the GPU`);
            return { name: loaded.name, digest: loaded.digest, sizeVramBytes: loaded.size_vram };
        },
        async run(model, input) {
            const response = await request('/api/chat', {
                model,
                messages: input.messages,
                stream: true,
                think: false,
                options: {
                    num_predict: input.max_tokens,
                    num_gpu: -1,
                    temperature: 0,
                    num_ctx: contextTokens,
                },
                keep_alive: '5m',
            });
            if (!response.body) throw new Error('Local AI returned no stream');
            let buffer = '';
            let done = false;
            const encoder = new TextEncoder();
            const emit = (line, controller) => {
                if (!line.trim()) return;
                const item = JSON.parse(line);
                if (item.error) throw new Error(`Local AI: ${item.error}`);
                if (item.message?.content) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: item.message.content })}\n\n`));
                }
                if (item.done) {
                    done = true;
                    controller.enqueue(
                        encoder.encode(
                            `data: ${JSON.stringify({
                                usage: {
                                    prompt_tokens: item.prompt_eval_count,
                                    completion_tokens: item.eval_count,
                                },
                            })}\n\ndata: [DONE]\n\n`,
                        ),
                    );
                }
            };
            return response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
                new TransformStream({
                    transform(text, controller) {
                        buffer += text;
                        const lines = buffer.split('\n');
                        buffer = lines.pop();
                        for (const line of lines) emit(line, controller);
                    },
                    flush(controller) {
                        emit(buffer, controller);
                        if (!done) throw new Error('Local AI stream ended without completion');
                    },
                }),
            );
        },
    };
}
