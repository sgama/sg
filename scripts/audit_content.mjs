#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { glob } from 'glob';

const repoRoot = process.cwd();
const reportDir = process.env.REPORT_DIR || path.join(repoRoot, 'reports');
const requiredFields = (process.env.CONTENT_REQUIRED_FIELDS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
const recommendedFieldsRaw = (process.env.CONTENT_RECOMMENDED_FIELDS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
const requiredMin = Number.parseFloat(process.env.CONTENT_REQUIRED_MIN || '1.0');
const recommendedMin = Number.parseFloat(process.env.CONTENT_RECOMMENDED_MIN || '0.8');

const recommendedGroups = recommendedFieldsRaw.map((entry) => entry.split('|').map((v) => v.trim()));
for (const [name, value] of [
    ['CONTENT_REQUIRED_MIN', requiredMin],
    ['CONTENT_RECOMMENDED_MIN', recommendedMin],
]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
}

function policy(file) {
    const type = file.startsWith('content/_context/')
        ? 'context'
        : file.startsWith('content/posts/') && !file.endsWith('/_index.md')
          ? 'post'
          : 'page';
    return {
        type,
        required: requiredFields.length ? requiredFields : type === 'post' ? ['title', 'date'] : ['title'],
        recommended: recommendedGroups.length
            ? recommendedGroups
            : type === 'post'
              ? [['tags'], ['description', 'summary']]
              : [['description', 'summary']],
    };
}

function isValuePresent(value) {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
}

function groupSatisfied(data, group) {
    return group.some((field) => isValuePresent(data[field]));
}

function validDate(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime());
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return false;
    const date = new Date(value.slice(0, 10));
    return Number.isFinite(Date.parse(value)) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
}

function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
}

const contentFiles = (await glob('content/**/*.md', { nodir: true, ignore: ['content/_context/_index.md'] })).sort();

const results = contentFiles.map((filePath) => {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = matter(raw).data ?? {};
    const rules = policy(filePath.split(path.sep).join('/'));
    const missingRequired = rules.required.filter((field) => !isValuePresent(data[field]));
    const missingRecommended = rules.recommended.filter((group) => !groupSatisfied(data, group)).map((group) => group.join('|'));
    const invalidFields = [];
    if (rules.required.includes('date') && isValuePresent(data.date) && !validDate(data.date)) invalidFields.push('date');
    return {
        file: path.relative(repoRoot, filePath),
        type: rules.type,
        requiredFields: rules.required,
        recommendedFields: rules.recommended,
        missingRequired,
        missingRecommended,
        invalidFields,
    };
});

const totalFiles = results.length;
const requiredTotal = results.reduce((sum, r) => sum + r.requiredFields.length, 0);
const recommendedTotal = results.reduce((sum, r) => sum + r.recommendedFields.length, 0);
const requiredMissing = results.reduce((sum, r) => sum + r.missingRequired.length + r.invalidFields.length, 0);
const recommendedMissing = results.reduce((sum, r) => sum + r.missingRecommended.length, 0);
const requiredCoverage = requiredTotal === 0 ? 1 : (requiredTotal - requiredMissing) / requiredTotal;
const recommendedCoverage = recommendedTotal === 0 ? 1 : (recommendedTotal - recommendedMissing) / recommendedTotal;

const report = {
    totals: {
        files: totalFiles,
        requiredFields,
        policy: requiredFields.length || recommendedGroups.length ? 'explicit-overrides' : 'content-type',
        recommendedFields: recommendedGroups.map((g) => g.join('|')),
        requiredCoverage,
        recommendedCoverage,
        requiredMissing,
        recommendedMissing,
    },
    missing: results.filter((r) => r.missingRequired.length > 0 || r.missingRecommended.length > 0 || r.invalidFields.length > 0),
};

fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'content_audit.json'), JSON.stringify(report, null, 2));

const lines = [
    '## Content Coverage Report',
    '',
    `- Files scanned: ${totalFiles}`,
    `- Required coverage: ${formatPercent(requiredCoverage)} (min ${formatPercent(requiredMin)})`,
    `- Recommended coverage: ${formatPercent(recommendedCoverage)} (min ${formatPercent(recommendedMin)})`,
    '',
    '### Missing Fields',
    '',
];

if (report.missing.length === 0) {
    lines.push('All content meets required and recommended fields.');
} else {
    for (const item of report.missing) {
        const parts = [];
        if (item.missingRequired.length > 0) parts.push(`required: ${item.missingRequired.join(', ')}`);
        if (item.missingRecommended.length > 0) parts.push(`recommended: ${item.missingRecommended.join(', ')}`);
        if (item.invalidFields.length) parts.push(`invalid: ${item.invalidFields.join(', ')}`);
        lines.push(`- ${item.file} (${parts.join('; ')})`);
    }
}

const markdownOutput = `${lines.join('\n')}\n`;
fs.writeFileSync(path.join(reportDir, 'content_audit.md'), markdownOutput);

if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdownOutput);
}

const failures = [];
if (requiredCoverage < requiredMin) failures.push(`Required coverage ${formatPercent(requiredCoverage)} below ${formatPercent(requiredMin)}`);
if (recommendedCoverage < recommendedMin)
    failures.push(`Recommended coverage ${formatPercent(recommendedCoverage)} below ${formatPercent(recommendedMin)}`);

if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
}
