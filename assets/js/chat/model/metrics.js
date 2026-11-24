/**
 * @typedef {{ prompt_tokens?: number, completion_tokens?: number }} TokenUsage
 * @typedef {{ totalMs: number, firstTokenMs?: number, rewriteMs?: number, embeddingMs?: number, retrievalMs?: number, estimatedLlmCostUsd?: number, pricingDate?: string, rewriteUsed?: boolean, abstained?: boolean, generationUsage?: TokenUsage, rewriteUsage?: TokenUsage }} ResponseMetrics
 */

/** @param {number} ms */
export const duration = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);
/**
 * @param {unknown} value
 * @returns {value is number}
 */
export const validDuration = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
/**
 * @param {unknown} value
 * @returns {value is number}
 */
const validCount = (value) => Number.isInteger(value) && /** @type {number} */ (value) >= 0;
/**
 * @param {TokenUsage | undefined} usage
 * @returns {string[]}
 */
const tokens = (usage) => {
    const prompt = usage?.prompt_tokens;
    const completion = usage?.completion_tokens;
    return validCount(prompt) && validCount(completion)
        ? [prompt.toLocaleString('en-US'), completion.toLocaleString('en-US')]
        : ['Unavailable', 'Unavailable'];
};

/** @param {ResponseMetrics | null | undefined} metrics */
export function formatResponseMetrics(metrics) {
    if (!metrics || !validDuration(metrics.totalMs)) return null;
    const summary = [`🕧${duration(metrics.totalMs)}`];
    if (validDuration(metrics.firstTokenMs)) summary.push(`🪙${duration(metrics.firstTokenMs)}`);
    summary.push(validDuration(metrics.estimatedLlmCostUsd) ? `💲${metrics.estimatedLlmCostUsd.toFixed(6)}` : 'Cost unavailable');
    /** @type {[string, string][]} */
    const timing = [];
    for (const [key, label] of /** @type {['rewriteMs' | 'embeddingMs' | 'retrievalMs', string][]} */ ([
        ['rewriteMs', 'Rewrite'],
        ['embeddingMs', 'Embed'],
        ['retrievalMs', 'Search'],
    ])) {
        if (key === 'rewriteMs' && !metrics.rewriteUsed) continue;
        if (validDuration(metrics[key])) timing.push([label, duration(metrics[key])]);
    }
    /** @type {string[][]} */
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
