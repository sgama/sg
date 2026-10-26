// The evaluation surface the CLIs import; the seams live under ./evaluation/: fixtures (hashing and case schema),
// scoring (term checks and percentiles), runs (streams, retrieval and model comparison) and reports (release gates).
export { fixtureHash, promptHash, validateFixture } from './evaluation/fixtures.mjs';
export { percentile, retrievalEvidenceRate, scoreAnswer, scoreEvidence, scoreRetrievalQuery } from './evaluation/scoring.mjs';
export { compareModels, evaluateRetrieval, readAnswer } from './evaluation/runs.mjs';
export { validateComparisonReport, validateRetrievalReport } from './evaluation/reports.mjs';
