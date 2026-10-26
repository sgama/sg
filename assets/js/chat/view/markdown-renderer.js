/**
 * Loaders are injected by the host; without them the renderer stays in plain-text mode.
 * @param {{ loadModules?: (() => Promise<[{ marked: any }, { default: any }]>) | null, loadMermaid?: (() => Promise<any>) | null, warn?: (...args: unknown[]) => void }} [options]
 */
export function createMessageRenderer({ loadModules = null, loadMermaid = null, warn = (...args) => console.warn(...args) } = {}) {
    let markdown = null;
    let warnedUnavailable = false;
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
            if (!loadModules) return Promise.resolve();
            return (loading ??= Promise.resolve()
                .then(loadModules)
                .then(([markedModule, purifyModule]) => {
                    const marked = markedModule.marked;
                    purify = purifyModule.default;
                    if (typeof marked?.parse !== 'function' || typeof purify?.sanitize !== 'function') {
                        throw new Error('Chat markdown modules are incomplete.');
                    }
                    markdown = (text) =>
                        purify.sanitize(marked.parse(text, { gfm: true, breaks: true }), {
                            ALLOWED_TAGS: [
                                'p',
                                'br',
                                'strong',
                                'em',
                                'del',
                                'blockquote',
                                'ul',
                                'ol',
                                'li',
                                'pre',
                                'code',
                                'a',
                                'h1',
                                'h2',
                                'h3',
                                'h4',
                                'h5',
                                'h6',
                                'table',
                                'thead',
                                'tbody',
                                'tr',
                                'th',
                                'td',
                                'hr',
                            ],
                            ALLOWED_ATTR: ['href', 'title', 'class', 'start'],
                            FORBID_ATTR: ['style', 'id'],
                            FORBID_CONTENTS: ['script', 'style', 'svg', 'button', 'form', 'iframe', 'nav', 'header', 'footer', 'template'],
                            ALLOW_DATA_ATTR: false,
                            ALLOW_ARIA_ATTR: false,
                        });
                })
                .catch((error) => {
                    loading = null; // a later load() may retry
                    if (!warnedUnavailable) {
                        warnedUnavailable = true;
                        warn('Chat markdown unavailable; displaying plain text.', error);
                    }
                }));
        },
        renderDiagrams(element) {
            const blocks = [...element.querySelectorAll('pre > code.language-mermaid')].filter((code) => !rendering.has(code));
            for (const code of blocks) {
                rendering.add(code);
                diagramQueue = diagramQueue.then(async () => {
                    try {
                        const module = await (diagrams ??= Promise.resolve()
                            .then(() => {
                                if (!loadMermaid) throw new Error('Mermaid is not configured.');
                                return loadMermaid();
                            })
                            .catch((error) => {
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
                            note.textContent = 'Diagram unavailable. The Mermaid source is shown below.';
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
                element.querySelectorAll('[class]').forEach((node) => {
                    const language = node.tagName === 'CODE' && [...node.classList].find((name) => /^language-[\w-]+$/.test(name));
                    if (language) node.setAttribute('class', language);
                    else node.removeAttribute('class');
                });
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
