// Builds promptfoo tests from the labeled fixture; each label becomes one named metric.
import fs from 'node:fs';

/** @type {{ cases: import('../scripts/lib/evaluation/fixtures.mjs').FixtureCase[] }} */
const fixture = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/ai-eval.json', import.meta.url), 'utf8'));
// Arrays in `vars` make promptfoo fan out into one test per element, so labels travel in assertion config instead.
// Evidence and answer term checks are phrasing-sensitive, so they are reported (weight 0) but do not gate.
/**
 * @param {string} name
 * @param {string} metric
 * @param {unknown} item
 * @param {number} [weight]
 */
const check = (name, metric, item, weight = 1) => ({ type: 'javascript', value: `file://checks.mjs:${name}`, metric, weight, config: item });

export default fixture.cases.map((item) => ({
    description: item.id,
    vars: { query: item.query, history: JSON.stringify(item.history ?? []), labeled: String(item.expectedSources.length > 0) },
    assert: [
        item.expectedSources.length && check('retrievalHit', 'retrieval-hit', item),
        item.evidenceTerms && check('evidence', 'evidence', item, 0),
        item.retrievalTerms && check('rewrite', 'rewrite', item),
        check('answer', 'answer', item, 0),
    ].filter(Boolean),
}));
