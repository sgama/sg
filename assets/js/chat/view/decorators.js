// Message decorators: `(message, sender) => Node | null`. Build them with their dependencies and
// pass the list to createTranscript(); each one decides for itself whether it applies.
import { createEvidencePanel } from './evidence-panel.js';
import { createMetricsFooter } from './metrics-footer.js';

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
