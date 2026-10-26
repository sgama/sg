/**
 * Unit tests for AiService
 * Tests embedding generation, context retrieval, and stream generation
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiService } from '../../functions/_lib/ai.js';
import { AI_CONFIG, contextualizedQueryFromResponse } from '../../functions/_lib/application.js';
import { buildMessages } from '../../functions/_lib/prompts.js';
import { contextFromMatches, corpusRecordId, parentSectionIds, expandSectionMatches } from '../../functions/_lib/retrieval.js';
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
    assert.throws(
        () => expandSectionMatches([{ ...child, metadata: { ...child.metadata, canonicalIndex: -1, canonicalSource: 42 } }], []),
        /Invalid parent section reference/,
    );
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
    const { contextText: context, evidence } = await service.retrieve('Architecture?');
    assert.match(context, /Canonical deployment/);
    assert.match(context, /Unique curated architecture/);
    assert.equal(context.match(/Unique curated architecture/g).length, 1);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].url, '/canonical-project/');
    assert.doesNotMatch(evidence[0].text, /Unique curated/);
    assert.throws(() => expandSectionMatches([curated], []), /Missing or invalid/);
});

test('AiService', async (t) => {
    await t.test('generateStream', async (t) => {
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

        await t.test('forwards abort signal to AI.run', async () => {
            const controller = new AbortController();
            const svc = new AiService(
                makeEnv({
                    aiRun: async (_model, _payload, options) => {
                        assert.equal(options.signal, controller.signal);
                        return makeProviderStream('Answer');
                    },
                }),
            );

            const result = await svc.generateStream(SAMPLE_DATA.SAFE_QUERY, 'context text', FIXTURES.SIMPLE_HISTORY, { signal: controller.signal });
            assert.match(await new Response(result).text(), /"response":"Answer"/);
        });
    });

    await t.test('retrieve', async (t) => {
        await t.test('resolves parent sections through Vectorize even when chunks carry sectionText', async () => {
            const env = makeEnv({ aiRun: async () => buildEmbeddingsResponse([0.1, 0.2]) });
            env.AI_CORPUS_NAMESPACE = 'corpus-test';
            env.VECTORIZE_INDEX = {
                query: async () =>
                    buildVectorizeResult([
                        {
                            source: 'content/posts/a/index.md',
                            parentIndex: -1,
                            text: 'child excerpt',
                            sectionText: 'Truncated copy of the parent section',
                        },
                    ]),
                getByIds: async () => [
                    {
                        id: 'parent',
                        metadata: {
                            recordType: 'section',
                            source: 'content/posts/a/index.md',
                            sectionIndex: -1,
                            text: 'Full parent section text',
                            type: 'content',
                        },
                    },
                ],
            };

            const result = (await new AiService(env).retrieve('query')).contextText;

            assert.equal(result, 'Full parent section text');
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

            (
                await svc.retrieve('Most recently?', [
                    { role: 'user', content: 'What did he do last?' },
                    { role: 'assistant', content: 'He had an internship in 2016.' },
                ])
            ).contextText;

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

            (await svc.retrieve('Standalone question')).contextText;

            assert.deepEqual(payloads, [{ text: ['Standalone question'] }]);
        });
    });
});

test('service failures surface as 503s with the cause logged once', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const failure = new Error('upstream down');
    const fail = async () => {
        throw failure;
    };
    const embedded = async () => buildEmbeddingsResponse([0.1]);
    const noMatches = async () => buildVectorizeResult([]);
    const search = t.mock.fn(noMatches);
    const withMatches = (matches, getByIds = async () => []) =>
        new AiService({ AI_CORPUS_NAMESPACE: 'corpus-test', AI: { run: embedded }, VECTORIZE_INDEX: { query: async () => ({ matches }), getByIds } });
    const scenarios = [
        {
            service: new AiService(makeEnv({ aiRun: fail })),
            run: (svc) => svc.generateStream('query', 'context'),
            message: 'Generation service unavailable',
            label: 'Generation Failed:',
            cause: failure,
        },
        {
            service: new AiService(makeEnv({ aiRun: fail, vectorizeQuery: noMatches })),
            run: (svc) => svc.retrieve('Follow-up?', [{ role: 'user', content: 'Earlier question?' }]),
            message: 'Query contextualization service unavailable',
            label: 'Query Contextualization Failed:',
            cause: failure,
        },
        {
            service: new AiService(makeEnv({ aiRun: async () => ({ data: [[]] }) })),
            run: (svc) => svc.getEmbeddings('query'),
            message: 'Embedding service unavailable',
            label: 'Embedding Generation Failed:',
            cause: /Invalid embedding response/,
        },
        {
            service: new AiService(makeEnv({ aiRun: fail, vectorizeQuery: search })),
            run: (svc) => svc.retrieve('query'),
            message: 'Embedding service unavailable',
            label: 'Embedding Generation Failed:',
            cause: failure,
            after: () => assert.equal(search.mock.callCount(), 0, 'A failed embedding must not search'),
        },
        {
            service: new AiService(makeEnv({ aiRun: embedded, vectorizeQuery: fail })),
            run: (svc) => svc.retrieve('query'),
            message: 'Retrieval service unavailable',
            label: 'Vector Search Failed:',
            cause: failure,
        },
        {
            service: new AiService({ AI: { run: embedded } }),
            run: (svc) => svc.retrieve('query'),
            message: 'Retrieval service unavailable',
            label: 'Vector Search Failed: VECTORIZE_INDEX binding missing',
        },
        {
            service: withMatches([{ metadata: { recordType: 'chunk', source: 'content/page.md', parentIndex: -1, text: 'Partial evidence' } }]),
            run: (svc) => svc.retrieve('before that'),
            message: 'Retrieval service unavailable',
            label: 'Vector Search Failed:',
            cause: /Missing or invalid parent section/,
        },
        {
            service: withMatches([{ id: 'old', metadata: { text: 'Old evidence' } }]),
            run: (svc) => svc.retrieve('query'),
            message: 'Retrieval service unavailable',
            label: 'Vector Search Failed:',
            cause: /Unsupported corpus record type/,
        },
    ];
    for (const { service, run, message, label, cause, after } of scenarios) {
        logged.mock.resetCalls();
        await assert.rejects(run(service), { status: 503, message });
        assert.equal(logged.mock.callCount(), 1, label);
        const [actualLabel, actualCause] = logged.mock.calls[0].arguments;
        assert.equal(actualLabel, label);
        if (cause instanceof RegExp) assert.match(actualCause.message, cause);
        else if (cause) assert.equal(actualCause, cause);
        after?.();
    }
});

test('retrieval keeps text-bearing matches, passes the namespace and skips unrelated section lookups', async () => {
    for (const [matches, expected] of [
        [[], ''],
        [[{ id: 'current', metadata: { recordType: 'chunk', text: 'Original evidence' } }], 'Original evidence'],
        [[{ metadata: { recordType: 'chunk', text: 'good chunk' } }, { metadata: { recordType: 'chunk' } }], 'good chunk'],
    ]) {
        const svc = new AiService({
            AI_CORPUS_NAMESPACE: 'corpus-test',
            AI: { run: async () => buildEmbeddingsResponse([0.1]) },
            VECTORIZE_INDEX: {
                query: async (_, options) => {
                    assert.equal(options.namespace, 'corpus-test');
                    return { matches };
                },
                getByIds: async () => assert.fail('Unrelated parent lookup'),
            },
        });
        assert.equal((await svc.retrieve('question')).contextText, expected);
    }
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
