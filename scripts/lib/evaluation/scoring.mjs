/**
 * @typedef {import('./fixtures.mjs').FixtureCase} FixtureCase
 */

/**
 * @param {string} answer
 * @param {Pick<FixtureCase, 'answerTerms' | 'forbiddenTerms'>} item
 */
export function scoreAnswer(answer, item) {
    const text = answer.toLowerCase();
    return (
        item.answerTerms.every((group) => group.some((term) => text.includes(term.toLowerCase()))) &&
        !item.forbiddenTerms.some((term) => text.includes(term.toLowerCase()))
    );
}

/**
 * @param {string} context
 * @param {Pick<FixtureCase, 'evidenceTerms'>} item
 */
export function scoreEvidence(context, item) {
    if (!item.evidenceTerms) return null;
    const text = context.replace(/^Source: \{[^\n]*\}\r?\n/gm, '').toLowerCase();
    return item.evidenceTerms.every((group) => group.some((term) => text.includes(term.toLowerCase())));
}

/**
 * @param {string} query
 * @param {Pick<FixtureCase, 'retrievalTerms'>} item
 */
export function scoreRetrievalQuery(query, item) {
    if (!item.retrievalTerms) return null;
    const text = query.toLowerCase();
    return item.retrievalTerms.every((group) => group.some((term) => text.includes(term.toLowerCase())));
}
