const VISIBLE_CHIPS = 4;

/**
 * A click on the homepage avatar stage replays its spin. The class is removed when the spin ends and
 * re-added after a reflow, so repeated clicks restart cleanly. Not a link, so no keyboard action.
 */
export const avatarSpin = {
    name: 'avatar-spin',
    init({ document, window }) {
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        document.addEventListener('click', (event) => {
            const stage = event.target.closest('.intro__avatar-stage');
            if (!stage || reduced) return;
            stage.classList.remove('is-spinning');
            void stage.offsetWidth;
            stage.classList.add('is-spinning');
        });
        document.addEventListener('animationend', (event) => {
            if (event.animationName !== 'avatarSpin') return;
            event.target.closest('.intro__avatar-stage')?.classList.remove('is-spinning');
        });
    },
};

/** Any `.js-chat-trigger` element opens the assistant, optionally prefilled from `data-question`. */
export const chatTriggers = {
    name: 'chat-triggers',
    init({ document }) {
        document.addEventListener('click', (event) => {
            const trigger = event.target.closest('.js-chat-trigger');
            if (!trigger) return;
            const widget = document.querySelector('ai-chat-widget');
            if (!widget) return;
            event.preventDefault();
            const question = trigger.dataset.question;
            if (question && typeof widget.setPendingQuestion === 'function') widget.setPendingQuestion(question);
            widget.open?.();
        });
    },
};

/** Binds a settings toggle to the `disable-*` class and its checkboxes, syncing initial state and change events. */
function bindToggle(panel, document, suffix, setting) {
    const apply = (enabled) => document.documentElement.classList.toggle(suffix, enabled);
    const initial = Boolean(panel.getSettings()[setting]);
    apply(initial);
    for (const checkbox of document.querySelectorAll(`[id$="${suffix}"]`)) {
        checkbox.checked = initial;
        checkbox.addEventListener('change', (event) => {
            const enabled = event.target.checked;
            apply(enabled);
            panel.updateSetting(setting, enabled);
        });
    }
}

export const a11yStars = {
    name: 'a11y-stars',
    phase: 'idle',
    init({ document, window }) {
        const panel = window.A11yPanel;
        if (!panel) return;
        panel.addFeature('disableStars', {
            default: false,
            apply: (enabled) => document.documentElement.classList.toggle('disable-stars', enabled),
        });
        bindToggle(panel, document, 'disable-stars', 'disableStars');
    },
};

export const a11yBlur = {
    name: 'a11y-blur',
    phase: 'idle',
    init({ document, window }) {
        const panel = window.A11yPanel;
        if (!panel) return;
        bindToggle(panel, document, 'disable-blur', 'disableBlur');
    },
};

/** Keeps the first four homepage suggestion chips visible in template order. */
export const suggestionChips = {
    name: 'suggestion-chips',
    phase: 'idle',
    init({ document }) {
        for (const container of document.querySelectorAll('.chat-cta__chips')) {
            const buttons = Array.from(container.querySelectorAll('.chat-cta__chip'));
            for (let index = 0; index < buttons.length; index += 1) {
                buttons[index].hidden = index >= VISIBLE_CHIPS;
            }
        }
    },
};

/** Starts the CSS starfield once the page is idle; the stylesheet gates the animation on this class. */
export const starfield = {
    name: 'starfield',
    phase: 'idle',
    init({ document }) {
        document.documentElement.classList.add('stars-running');
    },
};
