// promptfoo assertions over the agent turn: tool behaviour, evidence URLs and answer text. Term scoring is shared with
// scripts/audit_rag.mjs (scripts/lib/evaluation/scoring.mjs).
import { isPublicUrl } from '../shared/ai/evidence.js';
import { scoreAnswer, scoreEvidence, scoreRetrievalQuery } from '../scripts/lib/evaluation/scoring.mjs';

/** @typedef {import('../scripts/lib/evaluation/fixtures.mjs').FixtureCase} FixtureCase */
/** @typedef {{ config: FixtureCase }} AssertContext */
/** @typedef {{ answer: string, queries: string[], searched: boolean, sources: string[], context: string, urls: string[] }} Output */

// The prompt forbids links, so any URL, markdown link or www host in the answer was written by the model.
const MODEL_LINK = /https?:\/\/|www\.|\]\(|\bcontent\/\S+\.md\b/i;

/**
 * @param {boolean | null} pass
 * @param {string} reason
 */
const result = (pass, reason) => ({ pass, score: pass ? 1 : 0, reason });

/** @param {Output} output @param {AssertContext} context */
export const searched = ({ queries }, { config }) =>
    result(!config.expectedSources.length || queries.length > 0, `searched ${queries.length} time(s): ${queries.join(' | ') || 'never'}`);

/** @param {Output} output @param {AssertContext} context */
export const retrievalHit = ({ sources }, { config }) =>
    result(
        config.expectedSources.some((source) => sources.includes(source)),
        `retrieved ${sources.join(', ') || 'nothing'}`,
    );

/** @param {Output} output @param {AssertContext} context */
export const evidence = ({ context }, { config }) => result(scoreEvidence(context, config), 'labeled evidence terms in retrieved text');

/** @param {Output} output @param {AssertContext} context */
export const query = ({ queries }, { config }) =>
    result(scoreRetrievalQuery(queries.join('\n'), config), `model search queries: ${queries.join(' | ') || 'none'}`);

/** @param {Output} output */
export const links = ({ answer, urls }) =>
    result(!MODEL_LINK.test(answer) && urls.every(isPublicUrl), `evidence urls: ${urls.join(', ') || 'none'}; no model-written links`);

/** @param {Output} output @param {AssertContext} context */
export const answer = (output, { config }) => result(scoreAnswer(output.answer, config), 'expected terms present, forbidden terms absent');
