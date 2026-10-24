import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const execute = promisify(execFile);

export async function publicSourceUrls(root, { hugo = process.env.HUGO || 'hugo' } = {}) {
    const { stdout } = await execute(hugo, ['list', 'published', '--source', root], { maxBuffer: 10 * 1024 * 1024 });
    // Hugo may emit warning/info lines to stdout before the CSV header (version-dependent);
    // keep only from the CSV header row onward.
    const lines = stdout.split(/\r?\n/);
    const headerIndex = lines.findIndex((line) => line.includes('permalink') && line.includes('path'));
    const csvText = headerIndex >= 0 ? lines.slice(headerIndex).join('\n') : stdout;
    const sources = new Map();
    for (const row of parse(csvText, { columns: true, skip_empty_lines: true, relax_column_count: true })) {
        const source = (path.isAbsolute(row.path) ? path.relative(root, row.path) : row.path).split(path.sep).join('/');
        if (source.startsWith('content/_context/')) continue;
        const url = new URL(row.permalink, 'https://hugo.invalid');
        if (!source.startsWith('content/') || sources.has(source) || !['http:', 'https:'].includes(url.protocol)) {
            throw new Error(`Invalid Hugo source provenance: ${source}`);
        }
        sources.set(source, url.pathname);
    }
    return sources;
}
