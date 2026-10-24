import { publicEvidence } from '../model/evidence.js';

export function createEvidencePanel(value, document, renderer) {
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
