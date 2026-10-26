const TOGGLE_SELECTOR = 'button[data-menu-toggle]';

const controlsFor = (document, checkbox) =>
    Array.from(document.querySelectorAll(TOGGLE_SELECTOR)).filter((button) => button.dataset.menuToggle === checkbox.id);

const syncControls = (document, checkbox) => {
    for (const button of controlsFor(document, checkbox)) button.setAttribute('aria-expanded', String(checkbox.checked));
};

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
        // Opening moves focus into the dialog so Tab does not start behind it.
        toggle.addEventListener('change', () => {
            if (toggle.checked) dialog.querySelector('a[href], button, input, [tabindex]:not([tabindex="-1"])')?.focus();
        });
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

/** Desktop submenus open on hover or focus and close on Escape or when focus leaves them. */
export const desktopDropdowns = {
    name: 'desktop-dropdowns',
    init({ document }) {
        for (const menu of document.querySelectorAll('.nested-menu')) {
            const trigger = menu.querySelector('[aria-haspopup]');
            if (!trigger) continue;
            const setExpanded = (expanded) => trigger.setAttribute('aria-expanded', String(expanded));
            menu.addEventListener('mouseenter', () => setExpanded(true));
            menu.addEventListener('mouseleave', () => setExpanded(false));
            menu.addEventListener('focusin', () => setExpanded(true));
            menu.addEventListener('focusout', (event) => {
                if (!menu.contains(event.relatedTarget)) setExpanded(false);
            });
            menu.addEventListener('keydown', (event) => {
                if (event.key !== 'Escape') return;
                if (menu.contains(document.activeElement)) trigger.focus();
                setExpanded(false);
            });
        }
    },
};
