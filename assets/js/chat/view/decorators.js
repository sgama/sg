// Per-message extras. A decorator is `(message, sender) => Node | null`: createTranscript() appends the
// nodes of every decorator after the rendered answer, and each decides for itself whether it applies.
import { publicEvidence } from '../model/evidence.js';
import { duration, formatResponseMetrics, validDuration } from '../model/metrics.js';

function createEvidencePanel(value, document, renderer) {
    const evidence = publicEvidence(value);
    if (!evidence.length) return null;
    const panel = document.createElement('details');
    panel.classList.add('response-evidence');
    const summary = document.createElement('summary');
    summary.textContent = `Retrieved sources (${evidence.length})`;
    panel.append(summary);
    const note = document.createElement('small');
    note.textContent = 'Public excerpts supplied to the assistant, not independent verification of its answer.';
    panel.append(note);
    for (const item of evidence) {
        const card = document.createElement('div');
        card.classList.add('evidence-card');
        const link = document.createElement('a');
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = item.section ? `${item.title} — ${item.section}` : item.title;
        const excerpt = document.createElement('div');
        excerpt.classList.add('evidence-excerpt');
        if (renderer) renderer.write(excerpt, item.text, 'bot');
        else excerpt.textContent = item.text;
        panel.addEventListener('toggle', () => {
            if (panel.open && renderer?.renderDiagrams) renderer.renderDiagrams(excerpt);
        });
        card.append(link, excerpt);
        panel.append(card);
    }
    return panel;
}

function createMetricsFooter(metrics, document) {
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

/** Public sources the assistant was given, shown under its answer. */
export const evidenceDecorator =
    ({ renderer }) =>
    (message, sender) =>
        sender === 'bot' && message?.evidence ? createEvidencePanel(message.evidence, document, renderer) : null;

/** A manual retry button on a failed exchange. */
export const retryDecorator =
    ({ retryFor, onRetry }) =>
    (message) => {
        const retry = message ? retryFor(message) : null;
        if (!retry) return null;
        const button = document.createElement('button');
        button.type = 'button';
        button.classList.add('chat-retry');
        button.textContent = 'Retry';
        button.addEventListener('click', () => onRetry(retry));
        return button;
    };

/** Latency, cost and token details under an assistant answer. */
export const metricsDecorator = () => (message, sender) => createMetricsFooter(sender === 'bot' ? message?.metrics : null, document);
