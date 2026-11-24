/**
 * A click on the homepage avatar stage replays its spin. The class is removed when the spin ends and
 * re-added after a reflow, so repeated clicks restart cleanly. Not a link, so no keyboard action.
 */
/** @type {import('../core/feature-host.js').Feature} */
export const avatarSpin = {
    name: 'avatar-spin',
    init({ document, window }) {
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        document.addEventListener('click', (event) => {
            const stage = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.intro__avatar-stage'));
            if (!stage || reduced) return;
            stage.classList.remove('is-spinning');
            void stage.offsetWidth;
            stage.classList.add('is-spinning');
        });
        document.addEventListener('animationend', (event) => {
            if (event.animationName !== 'avatarSpin') return;
            /** @type {Element} */ (event.target).closest('.intro__avatar-stage')?.classList.remove('is-spinning');
        });
    },
};

/** Any `.js-chat-trigger` element opens the assistant, optionally prefilled from `data-question`. */
/** @type {import('../core/feature-host.js').Feature} */
export const chatTriggers = {
    name: 'chat-triggers',
    init({ document }) {
        document.addEventListener('click', (event) => {
            const trigger = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.js-chat-trigger'));
            if (!trigger) return;
            const widget = /** @type {(HTMLElement & { setPendingQuestion?: (question: string) => void, open?: () => void }) | null} */ (
                document.querySelector('ai-chat-widget')
            );
            if (!widget) return;
            event.preventDefault();
            if (trigger.dataset.question) widget.setPendingQuestion?.(trigger.dataset.question);
            widget.open?.();
        });
    },
};

/**
 * @typedef {{ addFeature: (name: string, feature: { default: boolean, apply: (enabled: boolean) => void }) => void, getSettings: () => Record<string, unknown>, updateSetting: (name: string, value: boolean) => void }} A11yPanel
 */

/**
 * Binds a settings toggle to the `disable-*` class and its checkboxes, syncing initial state and change events.
 * @param {A11yPanel} panel
 * @param {Document} document
 * @param {string} suffix
 * @param {string} setting
 */
function bindToggle(panel, document, suffix, setting) {
    /** @param {boolean} enabled */
    const apply = (enabled) => document.documentElement.classList.toggle(suffix, enabled);
    const initial = Boolean(panel.getSettings()[setting]);
    apply(initial);
    for (const checkbox of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll(`[id$="${suffix}"]`))) {
        checkbox.checked = initial;
        checkbox.addEventListener('change', (event) => {
            const enabled = /** @type {HTMLInputElement} */ (event.target).checked;
            apply(enabled);
            panel.updateSetting(setting, enabled);
        });
    }
}

/** @type {import('../core/feature-host.js').Feature} */
export const a11yStars = {
    name: 'a11y-stars',
    phase: 'idle',
    init({ document, window }) {
        const panel = /** @type {{ A11yPanel?: A11yPanel }} */ (window).A11yPanel;
        if (!panel) return;
        panel.addFeature('disableStars', {
            default: false,
            apply: (enabled) => document.documentElement.classList.toggle('disable-stars', enabled),
        });
        bindToggle(panel, document, 'disable-stars', 'disableStars');
    },
};

/** @type {import('../core/feature-host.js').Feature} */
export const a11yBlur = {
    name: 'a11y-blur',
    phase: 'idle',
    init({ document, window }) {
        const panel = /** @type {{ A11yPanel?: A11yPanel }} */ (window).A11yPanel;
        if (!panel) return;
        bindToggle(panel, document, 'disable-blur', 'disableBlur');
    },
};

/** Starts the CSS starfield once the page is idle; the stylesheet gates the animation on this class. */
/** @type {import('../core/feature-host.js').Feature} */
export const starfield = {
    name: 'starfield',
    phase: 'idle',
    init({ document }) {
        document.documentElement.classList.add('stars-running');
    },
};
