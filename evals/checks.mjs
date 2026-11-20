// promptfoo assertions: deterministic checks shared with scripts/audit_rag.mjs (scripts/lib/evaluation/scoring.mjs).
import { scoreAnswer, scoreEvidence, scoreRetrievalQuery } from '../scripts/lib/evaluation/scoring.mjs';

const result = (pass, reason) => ({ pass, score: pass ? 1 : 0, reason });

export const retrievalHit = ({ sources }, { config }) =>
    result(
        config.expectedSources.some((source) => sources.includes(source)),
        `retrieved ${[...new Set(sources)].join(', ') || 'nothing'}`,
    );

export const evidence = ({ context }, { config }) => result(scoreEvidence(context, config), 'labeled evidence terms in retrieved context');

export const rewrite = ({ retrievalQuery }, { config }) => result(scoreRetrievalQuery(retrievalQuery, config), `rewritten query: ${retrievalQuery}`);

export const answer = (output, { config }) => result(scoreAnswer(output.answer, config), 'expected terms present, forbidden terms absent');
