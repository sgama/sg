import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const PUBLIC_DIR = 'public';
const STATIC_HEADERS = 'static/_headers';
const REPORT_DIR = 'reports';

const inlineScripts = new Set();
const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (full.endsWith('.html')) {
            const html = readFileSync(full, 'utf8');
            for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
                const body = match[1].trim();
                if (body) inlineScripts.add(body);
            }
        }
    }
};

walk(PUBLIC_DIR);

const hashes = [...inlineScripts].map((body) => {
    const digest = createHash('sha256').update(body).digest('base64');
    return `'sha256-${digest}'`;
});

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(join(REPORT_DIR, 'csp-hashes.txt'), hashes.join('\n') + '\n');

// Cloudflare Pages limits a single _headers line to ~2000 chars, so 130+ inline
// scripts cannot be enumerated there; 'unsafe-inline' keeps the header deployable
// until the inline scripts are hoisted into external files (see head.html refactor).
const base = readFileSync(STATIC_HEADERS, 'utf8').trimEnd();
const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self' https://formspree.io",
].join('; ');

const output = `${base}\n\n/*\n  Strict-Transport-Security: max-age=63072000; includeSubDomains\n  Content-Security-Policy: ${csp}\n`;

writeFileSync(join(PUBLIC_DIR, '_headers'), output);
console.log(`Enumerated ${hashes.length} inline-script hash(es) into reports/csp-hashes.txt.`);
console.log(`Generated CSP header into ${join(PUBLIC_DIR, '_headers')}.`);
