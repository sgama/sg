import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildMessages } from '../../functions/_lib/config.js';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { scoreAnswer } from '../../scripts/lib/ai-evaluation.mjs';
import { validateComparisonReport } from '../../scripts/ai-eval.mjs';
import { AI_CONFIG, getModel } from '../../functions/_lib/ai-config.js';
import { fixtureHash } from '../../scripts/lib/ai-evaluation.mjs';

test('published resume contains the supplied skills and employment facts', async () => {
    const resume = await readFile(new URL('../../content/resume/_index.md', import.meta.url), 'utf8');
    assert.match(resume, /Go, Python, Bash, C\/C\+\+, Java, JavaScript, Rust/);
    assert.match(resume, /Senior Service Reliability Engineer, GPU Infrastructure/);
    assert.match(resume, /Mar 2026 - Jun 2026/);
    assert.match(resume, /Jun 2017 - Sep 2018/);
    assert.match(resume, /12th of 1,000 teams/);
});

test('prompt uses retrieved evidence without injecting a separate resume copy', () => {
    const context = '## Technical Skills\nProgramming: Go, Python, Bash, C/C++, Java, JavaScript, Rust';
    const messages = buildMessages('Is C++ listed?', context,
        [{ role: 'assistant', content: 'C++ is not listed.' }]);
    assert.ok(messages[0].content.includes(context));
    assert.match(messages[0].content, /override conflicting older excerpts and conversation history/);
    assert.match(messages[0].content, /listing both languages/);
    assert.match(messages[0].content, /Do not treat an omitted fact as either confirmed or disproved/);
    assert.match(messages[0].content, /Do not exaggerate qualifications or suppress source-supported limitations/);
    assert.equal(messages.at(-1).content, 'Is C++ listed?');
    assert.ok(!buildMessages('Skills?', '')[0].content.includes('Mar 2026 - Jun 2026'));
});

test('indexed source facts remain available and answer checks reject a contradictory claim', async () => {
    const corpus = await buildCorpus();
    const chunks = corpus.chunks.filter(chunk => chunk.metadata.source === 'content/resume/_index.md');
    assert.ok(chunks.some(chunk => chunk.text.includes('C/C++')));
    const fixture = JSON.parse(await readFile(new URL('../fixtures/ai-eval.json', import.meta.url), 'utf8'));
    const cpp = fixture.cases.find(item => item.id === 'resume-cpp');
    assert.equal(scoreAnswer('Yes, C/C++ is listed in the [resume](/resume/).', cpp), true);
    assert.equal(scoreAnswer('C++ is not listed in the [resume](/resume/).', cpp), false);
    assert.equal(cpp.required, true);
});

test('a required resume failure blocks release even when aggregate threshold permits it', () => {
    const model = getModel('glm');
    const fixture = { cases: [{ id: 'cpp', answerTerms: [['yes']], forbiddenTerms: [], required: true }] };
    const retrievalReport = { kind: 'retrieval' };
    const report = {
        kind: 'comparison', namespace: 'test', fixtureHash: fixtureHash(fixture),
        promptHash: fixtureHash(buildMessages('__query__', '__context__')),
        contextMode: 'retrieved', maxCompletionTokens: AI_CONFIG.generation.maxCompletionTokens,
        modelConfigurations: { [model.id]: model }, retrievalHash: fixtureHash(retrievalReport),
        results: [{ caseId: 'cpp', repeat: 0, modelId: model.id, status: 'ok', answer: 'No' }],
    };
    assert.throws(() => validateComparisonReport(report, {
        namespace: 'test', fixture, model, minAnswerRate: 0, retrievalReport,
    }), /Required resume regression failed/);
});
