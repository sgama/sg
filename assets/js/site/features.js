const VISIBLE_CHIPS = 4;

const checkboxes = (document, suffix) => Array.from(document.querySelectorAll(`[id$="${suffix}"]`));

/** Returns `limit` random items without mutating the input (partial Fisher-Yates). */
export function sample(items, limit, random = Math.random) {
    const list = items.slice();
    const count = Math.min(limit, list.length);
    for (let i = 0; i < count; i += 1) {
        const j = i + Math.floor(random() * (list.length - i));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list.slice(0, count);
}

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

/** Binds a settings toggle to its checkboxes, syncing initial state and change events. */
function bindToggle(panel, document, suffix, setting, apply) {
    const initial = Boolean(panel.getSettings()[setting]);
    apply(initial);
    for (const checkbox of checkboxes(document, suffix)) {
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
        bindToggle(panel, document, 'disable-stars', 'disableStars', (enabled) =>
            document.documentElement.classList.toggle('disable-stars', enabled),
        );
    },
};

export const a11yBlur = {
    name: 'a11y-blur',
    phase: 'idle',
    init({ document, window }) {
        const panel = window.A11yPanel;
        if (!panel) return;
        bindToggle(panel, document, 'disable-blur', 'disableBlur', (enabled) => document.documentElement.classList.toggle('disable-blur', enabled));
    },
};

/** Shows a random handful of the homepage's suggestion chips on each visit. */
export const suggestionChips = {
    name: 'suggestion-chips',
    phase: 'idle',
    init({ document }) {
        for (const container of document.querySelectorAll('.chat-cta__chips')) {
            const buttons = Array.from(container.querySelectorAll('.chat-cta__chip'));
            if (!buttons.length) continue;
            const keep = new Set(sample(buttons, VISIBLE_CHIPS));
            for (const button of buttons) button.hidden = !keep.has(button);
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
