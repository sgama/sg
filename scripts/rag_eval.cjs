/**
 * Minimal hit@K evaluator for the portfolio-index Vectorize index.
 *
 * - Pure functions (hit, summarize) are exported for unit tests.
 * - Embedding + vectorize calls are narrow fetch wrappers; swap them to
 *   point at a different model or index with no other changes.
 * - Exits non-zero if pass rate < cases.passThreshold.
 *
 * Run: CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/rag_eval.js
 */
const fs = require('fs');
const path = require('path');
const Cloudflare = require('cloudflare');
require('dotenv').config();

const DEFAULTS = {
    evalFile: path.join(__dirname, '..', 'tests', 'rag_eval.json'),
    indexName: 'portfolio-index',
    embeddingModel: '@cf/baai/bge-base-en-v1.5',
};

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = process.env;

const cf = new Cloudflare({ apiToken: CLOUDFLARE_API_TOKEN });

async function embed(text, model = DEFAULTS.embeddingModel) {
    const result = await cf.ai.run(model, { account_id: CLOUDFLARE_ACCOUNT_ID, text: [text] });
    return result.data[0];
}

async function queryIndex(vector, topK, indexName = DEFAULTS.indexName) {
    const result = await cf.vectorize.indexes.query(indexName, {
        account_id: CLOUDFLARE_ACCOUNT_ID,
        vector,
        topK,
        returnMetadata: 'all',
    });
    return (result.matches || []).map(m => m.metadata?.text || '');
}

// Pure: did any expected substring appear in any chunk? (case-insensitive)
function hit(chunks, expected) {
    const haystack = chunks.join('\n').toLowerCase();
    const match = expected.find(e => haystack.includes(e.toLowerCase()));
    return { hit: Boolean(match), matched: match || null };
}

function summarize(results, threshold) {
    const hits = results.filter(r => r.hit).length;
    const rate = results.length ? hits / results.length : 0;
    return { hits, total: results.length, rate, passed: rate >= threshold };
}

async function runCase({ query, expected }, topK) {
    const vector = await embed(query);
    const chunks = await queryIndex(vector, topK);
    return { query, expected, ...hit(chunks, expected) };
}

async function main() {
    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
        console.error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in env');
        process.exit(2);
    }

    const spec = JSON.parse(fs.readFileSync(DEFAULTS.evalFile, 'utf8'));
    const topK = spec.topK ?? 3;
    const threshold = spec.passThreshold ?? 0.75;

    console.log(`🔎 rag_eval: hit@${topK}, threshold=${(threshold * 100).toFixed(0)}%, ${spec.cases.length} cases`);

    const results = [];
    for (const c of spec.cases) {
        try {
            const r = await runCase(c, topK);
            results.push(r);
            console.log(`${r.hit ? '✓' : '✗'} ${c.query}${r.hit ? `  (matched: "${r.matched}")` : ''}`);
        } catch (err) {
            results.push({ query: c.query, expected: c.expected, hit: false, matched: null, error: err.message });
            console.log(`✗ ${c.query}  (error: ${err.message})`);
        }
    }

    const sum = summarize(results, threshold);
    console.log(`\nhit@${topK}: ${sum.hits}/${sum.total}  (${(sum.rate * 100).toFixed(1)}%)  ${sum.passed ? 'PASS' : 'FAIL'}`);
    process.exit(sum.passed ? 0 : 1);
}

if (require.main === module) main();

module.exports = { hit, summarize, embed, queryIndex, runCase };
