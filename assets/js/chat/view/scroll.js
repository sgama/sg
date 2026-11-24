/**
 * @param {HTMLElement} element
 * @param {number} [threshold]
 */
function isNearBottom(element, threshold = 48) {
    return element.scrollHeight - element.clientHeight - element.scrollTop <= threshold;
}

/**
 * @param {HTMLElement} viewport
 * @param {HTMLElement} content
 * @param {HTMLButtonElement} latestButton
 * @param {{ isOpen: () => boolean, signal: AbortSignal, requestFrame?: typeof requestAnimationFrame, cancelFrame?: typeof cancelAnimationFrame, Observer?: typeof ResizeObserver }} options
 */
export function createChatScroller(
    viewport,
    content,
    latestButton,
    { isOpen, signal, requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame, Observer = globalThis.ResizeObserver },
) {
    let following = true;
    /** @type {number | null} */
    let frame = null;
    const updateButton = () => {
        latestButton.hidden = following;
    };
    /** @param {boolean} [force] */
    const schedule = (force = false) => {
        if (force) {
            following = true;
            updateButton();
        }
        if (frame !== null || !following || !isOpen()) return;
        frame = requestFrame(() => {
            frame = null;
            if (!following || !isOpen()) return;
            viewport.scrollTop = viewport.scrollHeight;
        });
    };
    viewport.addEventListener(
        'scroll',
        () => {
            following = isNearBottom(viewport);
            updateButton();
        },
        { passive: true, signal },
    );
    latestButton.addEventListener('click', () => schedule(true), { signal });
    const observer = Observer ? new Observer(() => schedule()) : null;
    observer?.observe(viewport);
    observer?.observe(content);
    return {
        changed: schedule,
        destroy() {
            observer?.disconnect();
            if (frame !== null) cancelFrame(frame);
            frame = null;
        },
    };
}
