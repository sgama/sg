import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/audit_content.mjs', import.meta.url));

async function audit(t, files, overrides = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sg-content-audit-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const [name, data] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await writeFile(path.join(root, name), data);
    }
    const summary = path.join(root, 'summary.md');
    const result = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        env: {
            ...process.env,
            REPORT_DIR: path.join(root, 'reports'),
            CONTENT_REQUIRED_FIELDS: 'title,date',
            CONTENT_RECOMMENDED_FIELDS: 'tags,description|summary',
            CONTENT_REQUIRED_MIN: '1.0',
            CONTENT_RECOMMENDED_MIN: '0.8',
            GITHUB_STEP_SUMMARY: summary,
            ...overrides,
        },
    });
    assert.ifError(result.error);
    return {
        result,
        report: JSON.parse(await readFile(path.join(root, 'reports/content_audit.json'), 'utf8')),
        markdown: await readFile(path.join(root, 'reports/content_audit.md'), 'utf8'),
        summary: overrides.GITHUB_STEP_SUMMARY === '' ? undefined : await readFile(summary, 'utf8'),
    };
}

test('empty corpora pass and section index pages are ignored', async (t) => {
    const { result, report, markdown } = await audit(t, { 'content/_index.md': 'Ignored' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.totals.files, 0);
    assert.equal(report.totals.requiredCoverage, 1);
    assert.equal(report.totals.recommendedCoverage, 1);
    assert.match(markdown, /All content meets/);
});

test('missing required and recommended fields fail with reports and actionable errors', async (t) => {
    const { result, report, markdown, summary } = await audit(t, {
        'content/missing.md': '---\ntitle: " "\ndate: null\ntags: []\ndescription: ""\n---\nBody',
        'content/plain.md': 'Body without front matter',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Required coverage 0.0% below 100.0%/);
    assert.match(result.stderr, /Recommended coverage 0.0% below 80.0%/);
    assert.equal(report.totals.requiredMissing, 4);
    assert.equal(report.totals.recommendedMissing, 4);
    assert.ok(report.missing.every((item) => item.missingRequired.join(',') === 'title,date'));
    assert.match(markdown, /required: title, date; recommended: tags, description\|summary/);
    assert.equal(summary, markdown);
});

test('present values and alternative summary fields meet configured thresholds', async (t) => {
    const { result, report } = await audit(
        t,
        {
            'content/valid.md': '---\ntitle: Valid\ndate: 2026-01-01\ntags: [test]\nsummary: Summary\n---\nBody',
            'content/partial.md': '---\ntitle: Partial\ndate: false\ntags: []\ndescription: Description\n---\nBody',
        },
        { CONTENT_RECOMMENDED_MIN: '0.75', GITHUB_STEP_SUMMARY: '' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.totals.requiredCoverage, 1);
    assert.equal(report.totals.recommendedCoverage, 0.75);
    assert.equal(report.missing.length, 1);
    assert.deepEqual(report.missing[0].missingRecommended, ['tags']);
});
