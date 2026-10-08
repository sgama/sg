/**
 * Unit tests for AiService
 * Tests embedding generation, context retrieval, and stream generation
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiService } from '../../functions/_lib/ai.js';
import {
    AI_CONFIG,
    buildMessages,
    contextualizedQueryFromResponse,
    contextFromMatches,
    corpusRecordId,
    parentSectionIds,
    expandSectionMatches,
} from '../../functions/_lib/application.js';
import { buildEmbeddingsResponse, buildVectorizeResult, SAMPLE_DATA, FIXTURES } from '../helpers/data.mjs';
import { makeEnv, makeProviderStream } from '../helpers/mocks.mjs';

test('section expansion preserves ranked source order, bounds evidence and rejects invalid references', async () => {
    const source = 'content/project.md';
    const parent = {
        id: await corpusRecordId('corpus-test', source, -1),
        metadata: { source, recordType: 'section', sectionIndex: -1, text: 'Full project section' },
    };
    const child = { id: 'child', score: 0.8, metadata: { recordType: 'chunk', source, parentIndex: -1, text: 'Partial section' } };
    const other = { id: 'other', score: 0.9, metadata: { recordType: 'chunk', source: 'content/other.md', text: 'Other source' } };
    assert.deepEqual(await parentSectionIds([other, child, child], 'corpus-test'), [parent.id]);
    const expanded = expandSectionMatches([other, child, child, parent], [parent]);
    assert.deepEqual(
        expanded.map((match) => match.id),
        ['other', parent.id],
    );
    assert.equal(expanded[1].score, child.score);
    await assert.rejects(parentSectionIds([child], undefined), /namespace/);
    await assert.rejects(parentSectionIds([{ metadata: { recordType: 'chunk', source, parentIndex: 0 } }], 'corpus-test'), /Invalid parent/);
    for (const sections of [
        null,
        [],
        [{ ...parent, metadata: { recordType: 'chunk', ...parent.metadata, source: 'content/other.md' } }],
        [{ ...parent, metadata: { recordType: 'chunk', ...parent.metadata, text: 'x'.repeat(AI_CONFIG.retrieval.maxSectionChars + 1) } }],
    ]) {
        assert.throws(() => expandSectionMatches([child], sections), /Invalid section|Missing or invalid parent/);
    }
    assert.ok(contextFromMatches(expanded).length <= AI_CONFIG.retrieval.maxContextChars);
});

test('canonical evidence supplements curated facts without exposing internal excerpts', async () => {
    const canonical = {
        id: 'canonical',
        metadata: {
            source: 'content/project.md',
            type: 'content',
            title: 'Project',
            url: '/canonical-project/',
            recordType: 'section',
            sectionIndex: -1,
            section: 'Deployment',
            text: 'Canonical deployment and rollback evidence.',
        },
    };
    const curated = {
        id: 'curated',
        score: 0.9,
        metadata: {
            recordType: 'chunk',
            source: 'content/_context/project.md',
            type: 'context',
            title: 'Curated project',
            canonicalSource: 'content/project.md',
            canonicalIndex: -1,
            text: 'Unique curated architecture facts.',
        },
    };
    const service = new AiService({
        AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
        AI_CORPUS_NAMESPACE: 'corpus-test',
        VECTORIZE_INDEX: {
            query: async () => ({ matches: [curated, curated] }),
            getByIds: async (ids) => {
                assert.deepEqual(ids, [await corpusRecordId('corpus-test', canonical.metadata.source, -1)]);
                return [canonical];
            },
        },
    });
    const context = await service.retrieveContext('Architecture?');
    assert.match(context, /Canonical deployment/);
    assert.match(context, /Unique curated architecture/);
    assert.equal(context.match(/Unique curated architecture/g).length, 1);
    assert.equal(service.evidence.length, 1);
    assert.equal(service.evidence[0].url, '/canonical-project/');
    assert.doesNotMatch(service.evidence[0].text, /Unique curated/);
    assert.throws(() => expandSectionMatches([curated], []), /Missing or invalid/);
});

test('AiService', async (t) => {
    await t.test('generateStream', async (t) => {
        await t.test('defaults history to empty array when omitted', async () => {
            const calls = [];
            const svc = new AiService(
                makeEnv({
                    aiRun: async (model, payload) => {
                        calls.push(payload);
                        return makeProviderStream('Answer');
                    },
                }),
            );

            await svc.generateStream('query', 'ctx');

            const { messages } = calls[0];
            // system + user only, no history in between
            assert.equal(messages.length, 2);
            assert.equal(messages[0].role, 'system');
            assert.equal(messages[1].role, 'user');
        });
        await t.test('passes system prompt, history, and user query to AI', async () => {
            const calls = [];
            const svc = new AiService(
                makeEnv({
                    aiRun: async (model, payload) => {
                        calls.push({ model, payload });
                        return makeProviderStream('Answer');
                    },
                }),
            );

            const result = await svc.generateStream(SAMPLE_DATA.SAFE_QUERY, 'context text', FIXTURES.SIMPLE_HISTORY);

            assert.match(await new Response(result).text(), /"response":"Answer"/);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].model, '@cf/zai-org/glm-4.7-flash');

            const { messages } = calls[0].payload;
            assert.equal(messages[0].role, 'system');
            assert.match(messages[0].content, /context text/);
            assert.deepEqual(messages.slice(1, -1), FIXTURES.SIMPLE_HISTORY);
            assert.equal(messages.at(-1).role, 'user');
            assert.equal(messages.at(-1).content, SAMPLE_DATA.SAFE_QUERY);
            assert.equal(calls[0].payload.stream, true);
            assert.deepEqual(calls[0].payload.chat_template_kwargs, { enable_thinking: false });
        });

        await t.test('reports generation service failure explicitly', async (t) => {
            const logged = t.mock.method(console, 'error', () => {});
            const failure = new Error('model unavailable');
            const svc = new AiService(
                makeEnv({
                    aiRun: async () => {
                        throw failure;
                    },
                }),
            );
            await assert.rejects(svc.generateStream('query', 'context'), {
                status: 503,
                message: 'Generation service unavailable',
            });
            assert.equal(logged.mock.callCount(), 1);
            assert.deepEqual(logged.mock.calls[0].arguments, ['Generation Failed:', failure]);
        });
    });

    await t.test('getEmbeddings', async (t) => {
        await t.test('reports service unavailable when AI throws', async (t) => {
            const logged = t.mock.method(console, 'error', () => {});
            const failure = new Error('AI unavailable');
            const svc = new AiService(
                makeEnv({
                    aiRun: async () => {
                        throw failure;
                    },
                }),
            );

            await assert.rejects(svc.getEmbeddings('hello'), {
                status: 503,
                message: 'Embedding service unavailable',
            });
            assert.equal(logged.mock.callCount(), 1);
            assert.deepEqual(logged.mock.calls[0].arguments, ['Embedding Generation Failed:', failure]);
        });

        await t.test('returns first vector from AI response', async () => {
            const vector = SAMPLE_DATA.EMBEDDING_VECTOR;
            const svc = new AiService(
                makeEnv({
                    aiRun: async () => buildEmbeddingsResponse(vector),
                }),
            );

            const result = await svc.getEmbeddings('hello');

            assert.deepEqual(result, vector);
        });
    });

    await t.test('retrieveContext', async (t) => {
        await t.test('joins matched text chunks with separator', async () => {
            const svc = new AiService(
                makeEnv({
                    aiRun: async () => buildEmbeddingsResponse([0.1, 0.2]),
                    vectorizeQuery: async () => buildVectorizeResult([{ text: 'chunk one' }, { text: 'chunk two' }]),
                }),
            );

            const result = await svc.retrieveContext('query');

            assert.equal(result, 'chunk one\n---\nchunk two');
        });

        await t.test('uses the latest prior user question to retrieve follow-up context', async () => {
            const requests = [];
            const svc = new AiService(
                makeEnv({
                    aiRun: async (_model, payload) => {
                        requests.push(payload);
                        if (payload.stream === false) return { response: "What was Samson Gama's most recently listed role?" };
                        return buildEmbeddingsResponse([0.1, 0.2]);
                    },
                    vectorizeQuery: async (vector) => {
                        assert.deepEqual(vector, [0.1, 0.2]);
                        return buildVectorizeResult([]);
                    },
                }),
            );

            await svc.retrieveContext('Most recently?', [
                { role: 'user', content: 'What did he do last?' },
                { role: 'assistant', content: 'He had an internship in 2016.' },
            ]);

            assert.deepEqual(JSON.parse(requests[0].messages[1].content), {
                history: [
                    { role: 'user', content: 'What did he do last?' },
                    { role: 'assistant', content: 'He had an internship in 2016.' },
                ],
                query: 'Most recently?',
            });
            assert.equal(requests[0].stream, false);
            assert.equal(requests[0].max_completion_tokens, AI_CONFIG.contextualization.maxCompletionTokens);
            assert.deepEqual(requests[1].text, ["What was Samson Gama's most recently listed role?"]);
        });

        await t.test('skips query contextualization when there is no chat history', async () => {
            const payloads = [];
            const svc = new AiService(
                makeEnv({
                    aiRun: async (_model, payload) => {
                        payloads.push(payload);
                        return buildEmbeddingsResponse([0.1]);
                    },
                    vectorizeQuery: async () => buildVectorizeResult([]),
                }),
            );

            await svc.retrieveContext('Standalone question');

            assert.deepEqual(payloads, [{ text: ['Standalone question'] }]);
        });

        await t.test('reports contextualization failures explicitly', async (t) => {
            const logged = t.mock.method(console, 'error', () => {});
            const svc = new AiService(
                makeEnv({
                    aiRun: async () => {
                        throw new Error('model unavailable');
                    },
                    vectorizeQuery: async () => buildVectorizeResult([]),
                }),
            );

            await assert.rejects(svc.retrieveContext('Follow-up?', [{ role: 'user', content: 'Earlier question?' }]), {
                status: 503,
                message: 'Query contextualization service unavailable',
            });
            assert.equal(logged.mock.calls[0].arguments[0], 'Query Contextualization Failed:');
        });

        await t.test('passes the selected corpus namespace to Vectorize', async () => {
            const svc = new AiService({
                ...makeEnv({
                    aiRun: async () => buildEmbeddingsResponse([0.1]),
                    vectorizeQuery: async (vector, options) => {
                        assert.equal(options.namespace, 'corpus-test');
                        return buildVectorizeResult([]);
                    },
                }),
                AI_CORPUS_NAMESPACE: 'corpus-test',
            });
            assert.equal(await svc.retrieveContext('query'), '');
        });

        await t.test('rejects malformed embeddings instead of abstaining', async (t) => {
            const logged = t.mock.method(console, 'error', () => {});
            const svc = new AiService(makeEnv({ aiRun: async () => ({ data: [[]] }) }));
            await assert.rejects(svc.getEmbeddings('query'), {
                status: 503,
                message: 'Embedding service unavailable',
            });
            assert.equal(logged.mock.callCount(), 1);
            const [label, failure] = logged.mock.calls[0].arguments;
            assert.equal(logged.mock.calls[0].arguments.length, 2);
            assert.equal(label, 'Embedding Generation Failed:');
            assert.ok(failure instanceof Error);
            assert.equal(failure.message, 'Invalid embedding response');
        });

        await t.test('expands matching chunks to their source section and deduplicates sibling hits', async () => {
            const source = 'content/posts/project/index.md';
            const section = {
                id: await corpusRecordId('corpus-test', source, -1),
                metadata: {
                    source,
                    recordType: 'section',
                    sectionIndex: -1,
                    title: 'Project',
                    url: '/posts/project',
                    section: 'Deployment',
                    text: 'Deploy with Hugo. Roll back with Cloudflare.',
                },
            };
            const svc = new AiService({
                AI_CORPUS_NAMESPACE: 'corpus-test',
                AI: { run: async () => buildEmbeddingsResponse([0.1]) },
                VECTORIZE_INDEX: {
                    query: async () => ({
                        matches: [
                            { id: 'child-one', metadata: { recordType: 'chunk', source, parentIndex: -1, text: 'Deploy with Hugo.' } },
                            { id: 'child-two', metadata: { recordType: 'chunk', source, parentIndex: -1, text: 'Roll back with Cloudflare.' } },
                            section,
                        ],
                    }),
                    getByIds: async (ids) => {
                        assert.deepEqual(ids, [section.id]);
                        return [section];
                    },
                },
            });
            const context = await svc.retrieveContext('How is the project deployed?');
            assert.equal(context.split('Roll back with Cloudflare.').length, 2);
            assert.match(context, /"url":"\/posts\/project"/);
            assert.match(context, /"section":"Deployment"/);
        });

        await t.test('missing parent section fails explicitly rather than silently using incomplete evidence', async (t) => {
            const logged = t.mock.method(console, 'error', () => {});
            const svc = new AiService({
                AI_CORPUS_NAMESPACE: 'corpus-test',
                AI: { run: async () => buildEmbeddingsResponse([0.1]) },
                VECTORIZE_INDEX: {
                    query: async () => ({
                        matches: [{ metadata: { recordType: 'chunk', source: 'content/page.md', parentIndex: -1, text: 'Partial evidence' } }],
                    }),
                    getByIds: async () => [],
                },
            });
            await assert.rejects(svc.retrieveContext('before that'), { status: 503, message: 'Retrieval service unavailable' });
            assert.match(logged.mock.calls[0].arguments[1].message, /Missing or invalid parent section/);
        });

        await t.test('does not fetch unrelated sections for unlinked hits or empty search results', async () => {
            for (const matches of [[], [{ id: 'current', metadata: { recordType: 'chunk', text: 'Original evidence' } }]]) {
                const svc = new AiService({
                    AI_CORPUS_NAMESPACE: 'corpus-test',
                    AI: { run: async () => buildEmbeddingsResponse([0.1]) },
                    VECTORIZE_INDEX: {
                        query: async () => ({ matches }),
                        getByIds: async () => assert.fail('Unrelated parent lookup'),
                    },
                });
                assert.equal(await svc.retrieveContext('question'), matches.length ? 'Original evidence' : '');
            }
        });

        await t.test('rejects legacy corpus records without an explicit type', async (t) => {
            const logged = t.mock.method(console, 'error', () => {});
            const svc = new AiService(
                makeEnv({
                    aiRun: async () => buildEmbeddingsResponse([0.1]),
                    vectorizeQuery: async () => ({ matches: [{ id: 'old', metadata: { text: 'Old evidence' } }] }),
                }),
            );
            await assert.rejects(svc.retrieveContext('query'), { status: 503, message: 'Retrieval service unavailable' });
            assert.equal(logged.mock.callCount(), 1);
            assert.match(logged.mock.calls[0].arguments[1].message, /Unsupported corpus record type/);
            assert.throws(() => expandSectionMatches([{ metadata: { text: 'Old evidence' } }], []), /Unsupported corpus record type/);
        });

        await t.test('reports service unavailable when embedding fails', async (t) => {
            const logged = t.mock.method(console, 'error', () => {});
            const failure = new Error('fail');
            const query = t.mock.fn(async () => {
                throw new Error('should not be called');
            });
            const svc = new AiService(
                makeEnv({
                    aiRun: async () => {
                        throw failure;
                    },
                    vectorizeQuery: query,
                }),
            );

            await assert.rejects(svc.retrieveContext('query'), {
                status: 503,
                message: 'Embedding service unavailable',
            });
            assert.equal(query.mock.callCount(), 0);
            assert.equal(logged.mock.callCount(), 1);
            assert.deepEqual(logged.mock.calls[0].arguments, ['Embedding Generation Failed:', failure]);
        });

        await t.test('reports service unavailable when vectorize throws', async (t) => {
            const logged = t.mock.method(console, 'error', () => {});
            const failure = new Error('vectorize down');
            const svc = new AiService(
                makeEnv({
                    aiRun: async () => buildEmbeddingsResponse([0.1]),
                    vectorizeQuery: async () => {
                        throw failure;
                    },
                }),
            );

            await assert.rejects(svc.retrieveContext('query'), {
                status: 503,
                message: 'Retrieval service unavailable',
            });
            assert.equal(logged.mock.callCount(), 1);
            assert.deepEqual(logged.mock.calls[0].arguments, ['Vector Search Failed:', failure]);
        });

        await t.test('reports service unavailable when VECTORIZE_INDEX is not bound', async (t) => {
            const logged = t.mock.method(console, 'error', () => {});
            const svc = new AiService({
                AI: { run: async () => buildEmbeddingsResponse([0.1]) },
            });

            await assert.rejects(svc.retrieveContext('query'), {
                status: 503,
                message: 'Retrieval service unavailable',
            });
            assert.equal(logged.mock.callCount(), 1);
            assert.deepEqual(logged.mock.calls[0].arguments, ['Vector Search Failed: VECTORIZE_INDEX binding missing']);
        });

        await t.test('returns empty string when no matches', async () => {
            const svc = new AiService(
                makeEnv({
                    aiRun: async () => buildEmbeddingsResponse([0.1]),
                    vectorizeQuery: async () => buildVectorizeResult([]),
                }),
            );

            const result = await svc.retrieveContext('query');

            assert.equal(result, '');
        });

        await t.test('skips matches with no metadata text', async () => {
            const svc = new AiService(
                makeEnv({
                    aiRun: async () => buildEmbeddingsResponse([0.1]),
                    vectorizeQuery: async () => ({
                        matches: [{ metadata: { recordType: 'chunk', text: 'good chunk' } }, { metadata: { recordType: 'chunk' } }],
                    }),
                }),
            );

            const result = await svc.retrieveContext('query');

            assert.equal(result, 'good chunk');
        });
    });
});

test('prompt uses retrieved evidence without injecting a separate resume copy', () => {
    const context = '## Technical Skills\nProgramming: Go, Python, Bash, C/C++, Java, JavaScript, Rust';
    const messages = buildMessages('Is C++ listed?', context, [{ role: 'assistant', content: 'C++ is not listed.' }]);
    assert.ok(messages[0].content.includes(context));
    assert.match(messages[0].content, /override conflicting older excerpts and conversation history/);
    assert.match(messages[0].content, /listing both languages/);
    assert.match(messages[0].content, /Do not treat an omitted fact as either confirmed or disproved/);
    assert.match(messages[0].content, /Do not exaggerate qualifications or suppress source-supported limitations/);
    assert.equal(messages.at(-1).content, 'Is C++ listed?');
    assert.ok(!buildMessages('Skills?', '')[0].content.includes('Mar 2026 - Jun 2026'));
});

test('contextualized query parsing accepts known response shapes and rejects unbounded output', () => {
    assert.equal(contextualizedQueryFromResponse({ response: '  Samson latest role?  ' }), 'Samson latest role?');
    assert.equal(contextualizedQueryFromResponse({ choices: [{ message: { content: 'Samson latest role?' } }] }), 'Samson latest role?');
    for (const response of [
        {},
        { response: '' },
        { response: 'x'.repeat(AI_CONFIG.contextualization.maxQueryChars + 1) },
        { response: 'query\nexplanation' },
    ]) {
        assert.throws(() => contextualizedQueryFromResponse(response));
    }
});

test('retrieved context preserves source identity within the character budget', () => {
    const context = contextFromMatches([
        {
            metadata: { recordType: 'chunk', source: 'content/resume/_index.md', title: 'Resume', url: '/resume/', text: 'Programming: C/C++' },
        },
        {
            metadata: { recordType: 'chunk', source: 'content/posts/old/index.md', title: 'Older post', url: '/posts/old/', text: 'Older evidence' },
        },
    ]);
    assert.match(context, /Source: .*"title":"Resume".*"url":"\/resume\/"/);
    assert.doesNotMatch(context, /content\/|"source":/);
    assert.match(context, /Source: .*"title":"Older post"/);
    assert.match(context, /Programming: C\/C\+\+\n---\nSource:/);
    const bounded = contextFromMatches([
        {
            metadata: { recordType: 'chunk', source: 'resume', url: '/resume/', text: 'x'.repeat(AI_CONFIG.retrieval.maxContextChars * 2) },
        },
    ]);
    assert.equal(bounded.length, AI_CONFIG.retrieval.maxContextChars);
});

test('evidence callbacks expose only excerpts that fit the exact generation context budget', () => {
    const excerpts = [];
    const context = contextFromMatches(
        [
            { metadata: { recordType: 'chunk', url: '/first/', title: 'First', text: 'a'.repeat(AI_CONFIG.retrieval.maxContextChars + 100) } },
            { metadata: { recordType: 'chunk', url: '/omitted/', text: 'Must not be exposed' } },
        ],
        (excerpt) => excerpts.push(excerpt),
    );
    assert.equal(context.length, AI_CONFIG.retrieval.maxContextChars);
    assert.equal(excerpts.length, 1);
    assert.ok(context.endsWith(excerpts[0].text));
    assert.equal(excerpts[0].url, '/first/');
    assert.ok(excerpts[0].text.length < AI_CONFIG.retrieval.maxContextChars);
});

test('internal education evidence exposes public citations but not corpus filenames to generation', () => {
    const context = contextFromMatches([
        {
            metadata: {
                recordType: 'chunk',
                source: 'content/_context/education-security.md',
                title: 'Education',
                text: 'University of British Columbia, B.A.Sc., Computer Engineering, 2017.\nSources: [resume](/resume/) and [about](/about/).',
            },
        },
    ]);
    assert.doesNotMatch(context, /content\/_context\/education-security\.md/);
    assert.match(context, /\[resume\]\(\/resume\/\)/);
    assert.match(context, /Computer Engineering, 2017/);
    const prompt = buildMessages('Where did he go to school?', context)[0].content;
    assert.match(prompt, /Use readable Markdown citations/);
    assert.match(prompt, /Do not concatenate citation URLs/);
    assert.match(prompt, /answer directly in one sentence/);
    assert.match(prompt, /use Resume for \/resume\/ and About for \/about\//);
    assert.match(prompt, /Do not use an internal excerpt's title/);
    assert.match(prompt, /Do not introduce answers with "Based on the retrieved context"/);
    assert.match(prompt, /Put the citation directly after the supported fact/);
});
