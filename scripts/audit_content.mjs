#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { glob } from 'glob';
import { runIfMain } from './lib/cli.mjs';

function policy(file, requiredFields, recommendedGroups) {
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

function parseList(raw) {
    return (raw || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
}

/**
 * Compute the content coverage report and its markdown rendering without touching the
 * filesystem beyond reading content files. Kept free of process.exit/env writes so it can
 * be exercised directly in tests.
 */
async function runAudit({ cwd = process.cwd(), env = process.env } = {}) {
    const requiredFields = parseList(env.CONTENT_REQUIRED_FIELDS);
    const recommendedGroups = parseList(env.CONTENT_RECOMMENDED_FIELDS).map((entry) => entry.split('|').map((v) => v.trim()));
    const requiredMin = Number.parseFloat(env.CONTENT_REQUIRED_MIN || '1.0');
    const recommendedMin = Number.parseFloat(env.CONTENT_RECOMMENDED_MIN || '0.8');
    for (const [name, value] of /** @type {[string, number][]} */ ([
        ['CONTENT_REQUIRED_MIN', requiredMin],
        ['CONTENT_RECOMMENDED_MIN', recommendedMin],
    ])) {
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1`);
    }

    const contentFiles = (await glob('content/**/*.md', { cwd, nodir: true, ignore: ['content/_context/_index.md'] })).sort();

    const results = await Promise.all(
        contentFiles.map(async (filePath) => {
            const raw = await fs.readFile(path.join(cwd, filePath), 'utf8');
            const data = matter(raw).data ?? {};
            const rules = policy(filePath.split(path.sep).join('/'), requiredFields, recommendedGroups);
            const missingRequired = rules.required.filter((field) => !isValuePresent(data[field]));
            const missingRecommended = rules.recommended.filter((group) => !groupSatisfied(data, group)).map((group) => group.join('|'));
            const invalidFields = [];
            if (rules.required.includes('date') && isValuePresent(data.date) && !validDate(data.date)) invalidFields.push('date');
            return {
                file: filePath,
                type: rules.type,
                requiredFields: rules.required,
                recommendedFields: rules.recommended,
                missingRequired,
                missingRecommended,
                invalidFields,
            };
        }),
    );

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
    const markdown = `${lines.join('\n')}\n`;

    const failures = [];
    if (requiredCoverage < requiredMin) failures.push(`Required coverage ${formatPercent(requiredCoverage)} below ${formatPercent(requiredMin)}`);
    if (recommendedCoverage < recommendedMin)
        failures.push(`Recommended coverage ${formatPercent(recommendedCoverage)} below ${formatPercent(recommendedMin)}`);

    return { report, markdown, failures };
}

/** CLI entry point: writes reports, appends the job summary and sets the exit code. */
export async function main({ cwd = process.cwd(), env = process.env } = {}) {
    const { report, markdown, failures } = await runAudit({ cwd, env });

    const reportDir = env.REPORT_DIR || path.join(cwd, 'reports');
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(path.join(reportDir, 'content_audit.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(reportDir, 'content_audit.md'), markdown);

    if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, markdown);

    if (failures.length > 0) {
        console.error(failures.join('\n'));
        process.exitCode = 1;
    }
}

runIfMain(import.meta.url, main, 'Content audit failed');
