// promptfoo assertions: deterministic checks shared with scripts/audit_rag.mjs (scripts/lib/evaluation/scoring.mjs).
import { scoreAnswer, scoreEvidence, scoreRetrievalQuery } from '../scripts/lib/evaluation/scoring.mjs';

/** @typedef {import('../scripts/lib/evaluation/fixtures.mjs').FixtureCase} FixtureCase */
/** @typedef {{ config: FixtureCase }} AssertContext */

/**
 * @param {boolean | null} pass
 * @param {string} reason
 */
const result = (pass, reason) => ({ pass, score: pass ? 1 : 0, reason });

/** @param {{ sources: string[] }} output @param {AssertContext} context */
export const retrievalHit = ({ sources }, { config }) =>
    result(
        config.expectedSources.some((source) => sources.includes(source)),
        `retrieved ${[...new Set(sources)].join(', ') || 'nothing'}`,
    );

/** @param {{ context: string }} output @param {AssertContext} context */
export const evidence = ({ context }, { config }) => result(scoreEvidence(context, config), 'labeled evidence terms in retrieved context');

/** @param {{ retrievalQuery: string }} output @param {AssertContext} context */
export const rewrite = ({ retrievalQuery }, { config }) => result(scoreRetrievalQuery(retrievalQuery, config), `rewritten query: ${retrievalQuery}`);

/** @param {{ answer: string }} output @param {AssertContext} context */
export const answer = (output, { config }) => result(scoreAnswer(output.answer, config), 'expected terms present, forbidden terms absent');
