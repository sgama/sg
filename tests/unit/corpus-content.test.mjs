import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildCorpus, ingestionText } from '../../scripts/lib/corpus.mjs';
import { corpusRecordId } from '../../functions/_lib/application.js';

test('canonical resume uses the same addressable parent sections as other sources', async () => {
    const corpus = await buildCorpus();
    const section = corpus.chunks.find(
        (chunk) =>
            chunk.metadata.source === 'content/resume/_index.md' &&
            chunk.metadata.section === 'Professional Experience' &&
            chunk.metadata.recordType === 'section',
    );
    assert.ok(section);
    assert.match(section.text, /Bitcomplete/);
    assert.match(section.text, /Demonware/);
    assert.match(section.text, /Aug 2020 - Jan 2026/);
    assert.match(section.text, /Oct 2018 - Jul 2020/);
    assert.equal(section.id, await corpusRecordId(corpus.namespace, section.metadata.source, section.chunkIndex));
    assert.equal(section.metadata.url, '/resume/');
    assert.doesNotMatch(section.text, /## Technical Skills/);
    assert.doesNotMatch(corpus.chunks.find((chunk) => chunk.metadata.source === 'content/_context/profile.md').text, /Employment chronology/);
});

test('homepage ingestion retains introductory prose without recreating presentation controls', async () => {
    const homepage = ingestionText((await readFile(new URL('../../content/_index.md', import.meta.url), 'utf8')).split('---').slice(2).join('---'));
    assert.match(homepage, /I build scalable/);
    assert.doesNotMatch(homepage, /<section|<div|<svg|Ask AI\n/);
});

test('published resume contains the supplied skills and employment facts', async () => {
    const resume = await readFile(new URL('../../content/resume/_index.md', import.meta.url), 'utf8');
    assert.match(resume, /Go, Python, Bash, C\/C\+\+, Java, JavaScript, Rust/);
    assert.match(resume, /Senior Service Reliability Engineer, GPU Infrastructure/);
    assert.match(resume, /Mar 2026 - Jun 2026/);
    assert.match(resume, /Jun 2017 - Sep 2018/);
    assert.match(resume, /12th of 1,000 teams/);
});

test('published resume skills remain available in the indexed corpus', async () => {
    const corpus = await buildCorpus();
    const chunks = corpus.chunks.filter((chunk) => chunk.metadata.source === 'content/resume/_index.md');
    assert.ok(chunks.some((chunk) => chunk.text.includes('C/C++')));
});

test('recruiter context contains sourced facts without authoring placeholders or public URLs', async () => {
    const corpus = await buildCorpus();
    const internal = corpus.chunks.filter((chunk) => chunk.metadata.type === 'context');
    assert.ok(internal.length >= 13);
    assert.ok(internal.every((chunk) => !Object.hasOwn(chunk.metadata, 'url')));
    assert.ok(internal.every((chunk) => !/<!--|FILL IN:/.test(chunk.text)));
    const skills = internal.filter((chunk) => chunk.metadata.source === 'content/_context/skills.md');
    assert.ok(skills.some((chunk) => /Go, Python, Bash, C\/C\+\+, Java,/.test(chunk.text)));
    const demonware = internal.filter((chunk) => chunk.metadata.source === 'content/_context/experience-demonware.md');
    assert.ok(demonware.some((chunk) => /Kubernetes, Go, Redis/.test(chunk.text)));
    const bitcomplete = internal.filter((chunk) => chunk.metadata.source === 'content/_context/experience-bitcomplete.md');
    assert.ok(bitcomplete.some((chunk) => /role ended in June 2026/.test(chunk.text)));
});
