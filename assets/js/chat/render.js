export function createMessageRenderer({
    loadModules = () => Promise.all([import('https://esm.sh/marked@13'), import('https://esm.sh/dompurify@3')]),
    loadMermaid = () => import('https://esm.sh/mermaid@11'),
    warn = (...args) => console.warn(...args),
} = {}) {
    let markdown = null;
    let loading = null;
    let purify = null;
    let diagrams = null;
    let diagramQueue = Promise.resolve();
    let diagramId = 0;
    const rendering = new WeakSet();
    return {
        get ready() {
            return markdown !== null;
        },
        load() {
            return (loading ??= Promise.resolve()
                .then(loadModules)
                .then(([markedModule, purifyModule]) => {
                    const marked = markedModule.marked;
                    purify = purifyModule.default;
                    if (typeof marked?.parse !== 'function' || typeof purify?.sanitize !== 'function') {
                        throw new Error('Chat markdown modules are incomplete.');
                    }
                    markdown = (text) => purify.sanitize(marked.parse(text, { gfm: true, breaks: true }));
                })
                .catch((error) => {
                    loading = null;
                    warn('Chat markdown unavailable; displaying plain text.', error);
                }));
        },
        renderDiagrams(element) {
            const blocks = [...element.querySelectorAll('pre > code.language-mermaid')].filter((code) => !rendering.has(code));
            for (const code of blocks) {
                rendering.add(code);
                diagramQueue = diagramQueue.then(async () => {
                    try {
                        const module = await (diagrams ??= loadMermaid().catch((error) => {
                            diagrams = null;
                            throw error;
                        }));
                        const mermaid = module.default;
                        mermaid.initialize({
                            startOnLoad: false,
                            securityLevel: 'strict',
                            suppressErrorRendering: true,
                            flowchart: { htmlLabels: false },
                        });
                        const { svg } = await mermaid.render(`chat-diagram-${++diagramId}`, code.textContent);
                        if (!element.contains(code)) return;
                        const diagram = code.ownerDocument.createElement('div');
                        diagram.classList.add('evidence-diagram');
                        diagram.innerHTML = purify.sanitize(svg, {
                            USE_PROFILES: { svg: true, svgFilters: true },
                            FORBID_TAGS: ['foreignObject', 'a'],
                        });
                        code.parentElement.replaceWith(diagram);
                    } catch (error) {
                        warn('Source diagram unavailable; retaining Mermaid code.', error);
                        if (element.contains(code)) {
                            const note = code.ownerDocument.createElement('small');
                            note.textContent = 'Diagram unavailable. Mermaid source is shown below; open the source page to view it.';
                            code.parentElement.before(note);
                        }
                    }
                });
            }
            return diagramQueue;
        },
        write(element, text, sender) {
            element.dataset.rawText = text;
            element.classList.toggle('message--loading', !text);
            if (sender === 'bot' && markdown && text) {
                element.innerHTML = markdown(text);
                element.querySelectorAll('a').forEach((link) => {
                    link.rel = 'noopener noreferrer';
                    link.target = '_blank';
                });
            } else {
                element.textContent = text || 'Thinking…';
            }
        },
    };
}

export const messageRenderer = createMessageRenderer();
