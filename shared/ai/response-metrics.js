import { AI_CONFIG, estimateCost } from './application.js';

/**
 * Times one chat request and renders the `metrics` event payload. Request-scoped and free of I/O; the clock is injectable.
 * @param {{ now?: () => number }} [options]
 */
export function createResponseMetrics({ now = () => performance.now() } = {}) {
    const started = now();
    /** @type {number | null} */
    let firstTokenMs = null;

    return {
        firstToken() {
            firstTokenMs ??= now() - started;
        },
        /** @param {{ model?: import('./application.js').Model, usage?: import('./application.js').Usage }} call */
        snapshot({ model, usage }) {
            return {
                totalMs: Math.round(now() - started),
                firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
                generationModel: model?.id ?? null,
                generationUsage: usage ?? null,
                estimatedLlmCostUsd: model ? estimateCost(usage, model) : null,
                pricingDate: AI_CONFIG.pricingDate,
            };
        },
    };
}
