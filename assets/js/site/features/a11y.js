// Bridges the site's decorative effects to the theme's accessibility panel (window.A11yPanel).
// Both features do nothing when the panel is not installed.

const checkboxes = (document, suffix) => Array.from(document.querySelectorAll(`[id$="${suffix}"]`));

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
        const initial = Boolean(panel.getSettings().disableStars);
        for (const checkbox of checkboxes(document, 'disable-stars')) {
            checkbox.checked = initial;
            checkbox.onchange = (event) => panel.updateSetting('disableStars', event.target.checked);
        }
    },
};

export const a11yBlur = {
    name: 'a11y-blur',
    phase: 'idle',
    init({ document, window }) {
        const panel = window.A11yPanel;
        if (!panel) return;
        const apply = (enabled) => document.documentElement.classList.toggle('disable-blur', enabled);
        apply(Boolean(panel.getSettings().disableBlur));
        for (const checkbox of checkboxes(document, 'disable-blur')) {
            checkbox.addEventListener('change', (event) => apply(event.target.checked));
        }
    },
};
