import { TOGGLE_SELECTOR, controlsFor, syncControls } from './toggles.js';

/** Escape or a click outside closes the mobile menu; Escape also returns focus to its opener. */
export const mobileMenuDismissal = {
    name: 'mobile-menu-dismissal',
    init({ document }) {
        const toggle = document.getElementById('mobile-menu-toggle');
        const dialog = document.getElementById('mobile-menu-dialog');
        if (!toggle || !dialog) return;
        const opener = controlsFor(document, toggle).find((button) => !dialog.contains(button));
        const close = () => {
            toggle.checked = false;
            syncControls(document, toggle);
        };
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && toggle.checked) {
                close();
                opener?.focus();
            }
        });
        document.addEventListener('click', (event) => {
            if (!toggle.checked || event.target === toggle || dialog.contains(event.target)) return;
            if (event.target.closest(TOGGLE_SELECTOR)) return;
            close();
        });
    },
};
