export const duration = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);
export const validDuration = (value) => Number.isFinite(value) && value >= 0;
const tokens = (usage) =>
    Number.isInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isInteger(usage?.completion_tokens) && usage.completion_tokens >= 0
        ? [usage.prompt_tokens.toLocaleString('en-US'), usage.completion_tokens.toLocaleString('en-US')]
        : ['Unavailable', 'Unavailable'];

export function formatResponseMetrics(metrics) {
    if (!metrics || !validDuration(metrics.totalMs)) return null;
    const summary = [`🕧${duration(metrics.totalMs)}`];
    if (validDuration(metrics.firstTokenMs)) summary.push(`🪙${duration(metrics.firstTokenMs)}`);
    summary.push(validDuration(metrics.estimatedLlmCostUsd) ? `💲${metrics.estimatedLlmCostUsd.toFixed(6)}` : 'Cost unavailable');
    const timing = [];
    for (const [key, label] of [
        ['rewriteMs', 'Rewrite'],
        ['embeddingMs', 'Embed'],
        ['retrievalMs', 'Search'],
    ]) {
        if (key === 'rewriteMs' && !metrics.rewriteUsed) continue;
        if (validDuration(metrics[key])) timing.push([label, duration(metrics[key])]);
    }
    const usage = metrics.abstained ? [] : [['Answer', ...tokens(metrics.generationUsage)]];
    if (metrics.rewriteUsed) usage.push(['Rewrite', ...tokens(metrics.rewriteUsage)]);
    return {
        summary: summary.join(' · '),
        timing,
        usage,
        abstained: Boolean(metrics.abstained),
        warning: 'AI answers may be inaccurate. 🤥🤖',
    };
}
