import { AI_CONFIG, estimateCost } from './application.js';

/**
 * Collects the timings and token usage of one chat request and renders the `metrics` event payload.
 * Request-scoped and free of I/O; the clock is injectable.
 */
export function createResponseMetrics({ model, rewriteModel, now = () => performance.now() }) {
    const started = now();
    const timings = { rewriteMs: 0, embeddingMs: 0, retrievalMs: 0 };
    let rewriteUsed = false;
    let rewriteUsage = null;
    let generationUsage = null;
    let firstTokenMs = null;

    return {
        /** Runs `work` and adds its duration to a timing bucket, even if it throws. */
        async time(bucket, work) {
            const begun = now();
            try {
                return await work();
            } finally {
                timings[bucket] += now() - begun;
            }
        },
        resetTiming(bucket) {
            timings[bucket] = 0;
        },
        /** Records the query-rewrite call; `begun` is the clock value taken before it started. */
        rewrite({ begun, usage }) {
            timings.rewriteMs = now() - begun;
            rewriteUsage = usage ?? null;
        },
        startRewrite() {
            rewriteUsed = true;
            return now();
        },
        firstToken() {
            firstTokenMs = now() - started;
        },
        generationUsed(usage) {
            generationUsage = usage;
        },
        snapshot({ abstained = false } = {}) {
            const generationCost = abstained ? 0 : estimateCost(generationUsage, model);
            const rewriteCost = rewriteUsed ? estimateCost(rewriteUsage, rewriteModel) : 0;
            return {
                ...Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, Math.round(value)])),
                totalMs: Math.round(now() - started),
                firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
                generationModel: abstained ? null : model.id,
                generationUsage,
                rewriteUsage,
                rewriteUsed,
                estimatedLlmCostUsd: generationCost === null || rewriteCost === null ? null : generationCost + rewriteCost,
                pricingDate: AI_CONFIG.pricingDate,
                abstained,
            };
        },
    };
}
