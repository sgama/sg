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

export function retrievalEvidenceRate(results, cases) {
    const labeled = cases.filter((item) => item.evidenceTerms);
    if (!labeled.length) return null;
    return (
        labeled.filter((item) => {
            const result = results.find((result) => result.caseId === item.id);
            return result && !result.error && typeof result.context === 'string' && scoreEvidence(result.context, item);
        }).length / labeled.length
    );
}

export function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
