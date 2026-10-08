const duration = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);
const validDuration = (value) => Number.isFinite(value) && value >= 0;
const tokens = (usage) =>
    Number.isInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isInteger(usage?.completion_tokens) && usage.completion_tokens >= 0
        ? `${usage.prompt_tokens} in / ${usage.completion_tokens} out`
        : 'unavailable';

export function formatResponseMetrics(metrics) {
    if (!metrics || !validDuration(metrics.totalMs)) return null;
    const timing = [`Total ${duration(metrics.totalMs)}`];
    if (validDuration(metrics.firstTokenMs)) timing.unshift(`TTFT ${duration(metrics.firstTokenMs)}`);
    for (const [key, label] of [
        ['embeddingMs', 'Embed'],
        ['retrievalMs', 'Search'],
        ['rewriteMs', 'Rewrite'],
    ]) {
        if (key === 'rewriteMs' && !metrics.rewriteUsed) continue;
        if (validDuration(metrics[key])) timing.push(`${label} ${duration(metrics[key])}`);
    }
    const usage = [metrics.abstained ? 'No answer model call' : `Answer tokens: ${tokens(metrics.generationUsage)}`];
    if (metrics.rewriteUsed) usage.push(`Rewrite tokens: ${tokens(metrics.rewriteUsage)}`);
    usage.push(validDuration(metrics.estimatedLlmCostUsd) ? `Est. LLM $${metrics.estimatedLlmCostUsd.toFixed(6)}` : 'LLM cost unavailable');
    return `${timing.join(' · ')}\n${usage.join(' · ')}\nCost excludes embeddings, Vectorize and hosting.`;
}
