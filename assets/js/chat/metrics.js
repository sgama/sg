const duration = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);
const validDuration = (value) => Number.isFinite(value) && value >= 0;
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

export function createMetricsFooter(metrics, document) {
    const formatted = formatResponseMetrics(metrics);
    if (!formatted) return null;
    const node = (tag, text, className) => {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.classList.add(className);
        return element;
    };
    const footer = node('div', undefined, 'response-metrics');
    const overview = node('span', `${formatted.summary} · `, 'metrics-summary');
    overview.title = `🕧 Total latency; 🪙 time to first answer token; 💲 estimated LLM token cost, not a billed amount. Server-side timings. Pricing: ${metrics.pricingDate || 'unknown'}. Excludes embeddings, Vectorize and hosting.`;
    overview.setAttribute(
        'aria-label',
        `${duration(metrics.totalMs)} total${validDuration(metrics.firstTokenMs) ? `; ${duration(metrics.firstTokenMs)} to first token` : ''}; ${validDuration(metrics.estimatedLlmCostUsd) ? `estimated cost $${metrics.estimatedLlmCostUsd.toFixed(6)}` : 'cost unavailable'}`,
    );
    const details = node('details', undefined, 'metrics-details');
    details.append(node('summary', 'Details'));
    const grid = node('div', undefined, 'metrics-grid');
    const timing = node('div');
    timing.append(node('strong', 'Timing'));
    for (const [label, value] of [
        ['Total', duration(metrics.totalMs)],
        ...(validDuration(metrics.firstTokenMs) ? [['First token', duration(metrics.firstTokenMs)]] : []),
    ]) {
        const row = node('div', undefined, 'metrics-timing-row');
        row.append(node('span', label), node('span', value));
        timing.append(row);
    }
    for (const [label, value] of formatted.timing) {
        const row = node('div', undefined, 'metrics-timing-row');
        row.append(node('span', label), node('span', value));
        timing.append(row);
    }
    const usage = node('div');
    if (formatted.abstained) usage.append(node('span', 'No answer model call'));
    if (formatted.usage.length) {
        const table = node('table');
        table.setAttribute('aria-label', 'Model token usage');
        const head = node('thead');
        const headings = node('tr');
        for (const label of ['Tokens', 'In', 'Out']) {
            const heading = node('th', label);
            heading.setAttribute('scope', 'col');
            headings.append(heading);
        }
        head.append(headings);
        const body = node('tbody');
        for (const row of formatted.usage) {
            const tr = node('tr');
            const label = node('th', row[0]);
            label.setAttribute('scope', 'row');
            tr.append(label, ...row.slice(1).map((value) => node('td', value)));
            body.append(tr);
        }
        table.append(head, body);
        usage.append(table);
    }
    grid.append(timing, usage);
    details.append(grid);
    const explanation = node(
        'small',
        'Server-side timing. Cost is an estimate for answer and rewrite tokens; other infrastructure is excluded.',
        'metrics-explanation',
    );
    details.append(explanation);
    footer.append(overview, details, node('small', formatted.warning, 'metrics-warning'));
    return footer;
}
