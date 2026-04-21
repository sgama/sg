/**
 * Pure reranking helpers. No I/O here — the LLM call lives in services.js.
 * Keeping the parse + order logic separate makes it trivial to unit-test
 * and to swap in a different scoring backend later.
 */

export function buildRerankPrompt(query, candidates, snippetChars = 400) {
    const numbered = candidates
        .map((text, i) => `[${i + 1}] ${text.slice(0, snippetChars)}`)
        .join("\n\n");
    return `Rate each passage's relevance to the query from 0 (unrelated) to 10 (directly answers it).
Output only a comma-separated list of integers in the same order, nothing else.

Query: ${query}

Passages:
${numbered}`;
}

/**
 * Parse an LLM score list and return the `finalK` candidates in descending
 * score order. If parsing yields fewer scores than candidates, fall back
 * to the original top-K — never silently drop data.
 */
export function pickTopK(candidates, scoresText, finalK) {
    const scores = (scoresText || "")
        .split(/[,\s]+/)
        .map(s => parseInt(s, 10))
        .filter(Number.isFinite);

    if (scores.length < candidates.length) {
        return candidates.slice(0, finalK);
    }

    return candidates
        .map((text, i) => ({ text, score: scores[i] ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, finalK)
        .map(x => x.text);
}
