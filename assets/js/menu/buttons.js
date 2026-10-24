import { TOGGLE_SELECTOR, syncControls } from './toggles.js';

/** Native buttons toggle their checkbox and keep every control's `aria-expanded` in sync. */
export const menuButtons = {
    name: 'menu-buttons',
    init({ document, window, log }) {
        const checkboxes = new Set();
        for (const button of document.querySelectorAll(TOGGLE_SELECTOR)) {
            const checkbox = document.getElementById(button.dataset.menuToggle);
            if (!checkbox || checkbox.type !== 'checkbox') {
                log.error('Menu toggle checkbox missing:', button.dataset.menuToggle);
                continue;
            }
            button.addEventListener('click', () => {
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
            });
            if (checkboxes.has(checkbox)) continue;
            checkboxes.add(checkbox);
            checkbox.addEventListener('change', () => syncControls(document, checkbox));
            syncControls(document, checkbox);
        }
    },
};
