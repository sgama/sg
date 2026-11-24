import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';
import { ingestionText } from '../../scripts/lib/content-normalization.mjs';

// Built once per file: every test here only reads the repository corpus.
let repoCorpusPromise;
const repoCorpus = () => (repoCorpusPromise ??= buildCorpus());

test('homepage ingestion retains introductory prose without recreating presentation controls', async () => {
    const homepage = ingestionText((await readFile(new URL('../../content/_index.md', import.meta.url), 'utf8')).split('---').slice(2).join('---'));
    assert.match(homepage, /I build scalable/);
    assert.doesNotMatch(homepage, /<section|<div|<svg|Ask AI\n/);
});

test('published resume contains the supplied skills and employment facts', async () => {
    const resume = await readFile(new URL('../../content/resume/_index.md', import.meta.url), 'utf8');
    assert.match(resume, /Go, Python, Bash, C\/C\+\+, Rust, Java, JavaScript, PHP/);
    assert.match(resume, /Senior Software Developer/);
    assert.match(resume, /10 million requests per minute/);
    assert.match(resume, /Mar 2026 - Jun 2026/);
    assert.match(resume, /Jun 2017 - Sep 2018/);
    assert.match(resume, /12th of 1,000 teams/);
});

test('published resume skills remain available in the indexed corpus', async () => {
    const corpus = await repoCorpus();
    assert.ok(corpus.items.find((item) => item.key === 'content/resume/_index.md').text.includes('C/C++'));
});

test('recruiter context contains sourced facts without authoring placeholders; only linked context carries a page URL', async () => {
    const corpus = await repoCorpus();
    const internal = corpus.items.filter((item) => item.key.startsWith('content/_context/') && !item.key.endsWith('/_index.md'));
    assert.ok(internal.length >= 13);
    assert.ok(internal.every((item) => !/<!--|FILL IN:/.test(item.text)));
    assert.ok(internal.every((item) => item.metadata.url === undefined || !item.metadata.url.startsWith('/_context')));
    assert.equal(internal.find((item) => item.key === 'content/_context/profile.md').metadata.url, '/resume/');
    assert.match(internal.find((item) => item.key === 'content/_context/skills.md').text, /Go, Python, Bash, C\/C\+\+, Rust, Java,/);
    assert.match(internal.find((item) => item.key === 'content/_context/experience-demonware.md').text, /Go, Kubernetes and Redis/);
    assert.match(internal.find((item) => item.key === 'content/_context/experience-bitcomplete.md').text, /role ended in June 2026/);
});

test('resume is indexed as a single public item with its URL', async () => {
    const corpus = await repoCorpus();
    const resume = corpus.items.find((item) => item.key === 'content/resume/_index.md');
    assert.ok(resume);
    assert.equal(resume.metadata.url, '/resume/');
    assert.match(resume.text, /Bitcomplete/);
    assert.match(resume.text, /Demonware/);
    assert.match(resume.text, /Aug 2020 - Jan 2026/);
    assert.match(resume.text, /Oct 2018 - Jul 2020/);
    assert.match(resume.text, /## .*Technical Skills/);
});
