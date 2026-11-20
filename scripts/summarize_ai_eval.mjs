#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Count passing cases overall and per gating assertion metric in a promptfoo report.
 * Weight-0 (advisory) assertions always report pass, so they are skipped.
 * @param {{results: {results: Array<{success?: boolean, gradingResult?: {componentResults?: Array<{pass?: boolean, assertion?: {metric?: string, weight?: number}}>}}>}}} report
 * @returns {{cases: [number, number], metrics: Record<string, [number, number]>}}
 */
export function summarize(report) {
    const rows = report.results.results;
    /** @type {Record<string, [number, number]>} */
    const metrics = {};
    for (const row of rows) {
        for (const part of row.gradingResult?.componentResults ?? []) {
            if (part.assertion?.weight === 0) continue;
            const name = part.assertion?.metric ?? 'unnamed';
            metrics[name] ??= [0, 0];
            metrics[name][1] += 1;
            if (part.pass) metrics[name][0] += 1;
        }
    }
    return { cases: [rows.filter((row) => row.success).length, rows.length], metrics };
}

/**
 * @param {[number, number]} counts
 * @returns {string}
 */
const format = ([pass, total]) => `${pass}/${total} (${((100 * pass) / total).toFixed(1)}%)`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { cases, metrics } = summarize(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(`cases passed  ${format(cases)}`);
    for (const [name, counts] of Object.entries(metrics).sort()) {
        console.log(`${name.padEnd(13)} ${format(counts)}`);
    }
}
