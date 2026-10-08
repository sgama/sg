export function createMessageRenderer({
    loadModules = () => Promise.all([import('https://esm.sh/marked@13'), import('https://esm.sh/dompurify@3')]),
    warn = (...args) => console.warn(...args),
} = {}) {
    let markdown = null;
    let loading = null;
    return {
        get ready() {
            return markdown !== null;
        },
        load() {
            return (loading ??= Promise.resolve()
                .then(loadModules)
                .then(([markedModule, purifyModule]) => {
                    const marked = markedModule.marked;
                    const purify = purifyModule.default;
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
