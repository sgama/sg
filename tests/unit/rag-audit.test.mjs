import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { auditRag } from '../../scripts/audit_rag.mjs';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-rag-audit-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const dir of ['data', 'content/_context']) await fs.mkdir(path.join(root, dir), { recursive: true });
    const source = '---\ntitle: Resume\n---\nGo and Redis.';
    await fs.writeFile(path.join(root, 'content/resume.md'), source);
    await fs.writeFile(path.join(root, 'content/_context/skills.md'), '---\ntitle: Skills\n---\nGo and Redis.\n<!-- FILL IN: incident example -->');
    await fs.writeFile(path.join(root, 'data/prompts.yml'), 'prompts:\n  - What did he build?\n');
    const config = {
        version: 1,
        reviewed: '2026-10-07',
        sources: { 'content/resume.md': createHash('sha256').update(source).digest('hex') },
        documents: { 'content/_context/skills.md': ['content/resume.md'] },
        questions: [
            {
                query: 'What did he build?',
                sources: ['content/_context/skills.md'],
                evidenceTerms: [['go'], ['redis']],
            },
        ],
    };
    const save = () => fs.writeFile(path.join(root, 'data/rag_audit.json'), JSON.stringify(config));
    await save();
    return { root, config, save, now: new Date('2026-10-08T00:00:00Z') };
}

test('audit reports documented questions and nonfatal authoring gaps without model calls', async (t) => {
    const options = await fixture(t);
    const report = await auditRag(options);
    assert.equal(report.totals.documented, 1);
    assert.equal(report.totals.authoringGaps, 1);
    assert.equal(report.errors.length, 0);
    assert.match(report.warnings.join('\n'), /Authoring gaps/);
});

test('broken sources, metadata and invalid dates are explicit errors', async (t) => {
    const options = await fixture(t);
    await fs.unlink(path.join(options.root, 'content/resume.md'));
    options.config.reviewed = '2026-02-30';
    options.config.documents['content/_context/missing.md'] = [];
    options.config.sources['content/resume.md'] = 'invalid';
    await options.save();
    const report = await auditRag(options);
    assert.match(report.errors.join('\n'), /Invalid reviewed date/);
    assert.match(report.errors.join('\n'), /Missing canonical source/);
    assert.match(report.errors.join('\n'), /Invalid source hash/);
    assert.match(report.errors.join('\n'), /Missing mapped context document/);
});

test('changed sources and incomplete question mappings request review without inventing content', async (t) => {
    const options = await fixture(t);
    await fs.appendFile(path.join(options.root, 'content/resume.md'), '\nUpdated facts.');
    await fs.writeFile(path.join(options.root, 'data/prompts.yml'), 'prompts:\n  - What did he build?\n  - When can he start?\n');
    options.config.questions[0].evidenceTerms.push(['kubernetes']);
    options.config.reviewed = '2025-01-01';
    await options.save();
    const report = await auditRag(options);
    assert.deepEqual(report.changedSources, ['content/resume.md']);
    assert.deepEqual(
        report.coverage.map((item) => item.status),
        ['partial', 'unmapped'],
    );
    assert.deepEqual(report.coverage[0].missingEvidence, [['kubernetes']]);
    assert.match(report.warnings.join('\n'), /Source changed; review/);
    assert.match(report.warnings.join('\n'), /older than 90 days/);
});

test('malformed coverage and unsafe provenance paths fail explicitly', async (t) => {
    const options = await fixture(t);
    options.config.questions[0].evidenceTerms = [[]];
    await options.save();
    await assert.rejects(auditRag(options), /Malformed question/);
    options.config.sources['content/../../secret'] = '0'.repeat(64);
    await options.save();
    await assert.rejects(auditRag(options), /Invalid RAG source path/);
});
