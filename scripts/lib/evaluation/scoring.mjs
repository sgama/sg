export function scoreAnswer(answer, item) {
    const text = answer.toLowerCase();
    return (
        item.answerTerms.every((group) => group.some((term) => text.includes(term.toLowerCase()))) &&
        !item.forbiddenTerms.some((term) => text.includes(term.toLowerCase()))
    );
}

export function scoreEvidence(context, item) {
    if (!item.evidenceTerms) return null;
    const text = context.replace(/^Source: \{[^\n]*\}\r?\n/gm, '').toLowerCase();
    return item.evidenceTerms.every((group) => group.some((term) => text.includes(term.toLowerCase())));
}

export function scoreRetrievalQuery(query, item) {
    if (!item.retrievalTerms) return null;
    const text = query.toLowerCase();
    return item.retrievalTerms.every((group) => group.some((term) => text.includes(term.toLowerCase())));
}
