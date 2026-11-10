// Writes public/_headers: the static headers plus HSTS and the Content-Security-Policy.
// Scripts stay 'unsafe-inline' because Blowfish's inline scripts (over 100 of them) exceed the per-line
// header limit when hashed. Moving them into files would let this policy drop 'unsafe-inline'.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC_DIR = 'public';
const STATIC_HEADERS = 'static/_headers';

const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://ping.samsongama.com",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https://ping.samsongama.com",
    "img-src 'self' data:",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self' https://formspree.io",
].join('; ');

const base = readFileSync(STATIC_HEADERS, 'utf8').trimEnd();
const globalHeaders = ['  Strict-Transport-Security: max-age=63072000; includeSubDomains', `  Content-Security-Policy: ${csp}`].join('\n');
// Extend the static catch-all block so _headers never holds two /* blocks.
const catchAll = /^\/\*\n/m;
const output = catchAll.test(base) ? `${base.replace(catchAll, (match) => `${match}${globalHeaders}\n`)}\n` : `${base}\n\n/*\n${globalHeaders}\n`;

writeFileSync(join(PUBLIC_DIR, '_headers'), output);
console.log(`Generated Content-Security-Policy in ${join(PUBLIC_DIR, '_headers')}.`);
