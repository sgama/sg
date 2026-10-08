import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

const execute = promisify(execFile);

export async function publicSourceUrls(root, { hugo = process.env.HUGO || 'hugo' } = {}) {
    const { stdout } = await execute(hugo, ['list', 'published', '--source', root], { maxBuffer: 10 * 1024 * 1024 });
    const sources = new Map();
    for (const row of parse(stdout, { columns: true, skip_empty_lines: true })) {
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
