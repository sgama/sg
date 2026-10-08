export function publicEvidence(value) {
    if (!Array.isArray(value)) throw new Error('Invalid retrieved evidence');
    return value
        .filter(
            (item) =>
                item &&
                typeof item.url === 'string' &&
                /^\/(?!\/)/.test(item.url) &&
                !/[\\\r\n]/.test(item.url) &&
                !/\/_context(?:\/|$)/.test(item.url) &&
                typeof item.text === 'string' &&
                item.text.trim(),
        )
        .map(({ url, title, section, text }) => ({
            url,
            title: typeof title === 'string' ? title : 'Source',
            section: typeof section === 'string' ? section : '',
            text,
        }));
}

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
        card.append(link, excerpt);
        panel.append(card);
    }
    return panel;
}
