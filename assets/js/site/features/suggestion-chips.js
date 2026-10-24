const VISIBLE_CHIPS = 4;

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
