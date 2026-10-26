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

/** The mobile menu is a native modal dialog: showModal makes the page inert, and Escape, cancel and backdrop clicks close it. */
export const mobileMenuDismissal = {
    name: 'mobile-menu-dismissal',
    init({ document, window }) {
        const toggle = document.getElementById('mobile-menu-toggle');
        const dialog = document.getElementById('mobile-menu-dialog');
        if (!toggle || !dialog) return;
        const opener = controlsFor(document, toggle).find((button) => !dialog.contains(button));
        // Top-layer dialogs lose the header row as containing block, so anchor the dropdown to the row.
        const placeDropdown = () => {
            if (!dialog.classList.contains('mobile-menu-style-dropdown')) return;
            const row = dialog.parentElement.getBoundingClientRect();
            const rtl = window.getComputedStyle(dialog).direction === 'rtl';
            dialog.style.top = `calc(${row.bottom + window.scrollY}px + 0.75rem)`;
            dialog.style.insetInlineEnd = rtl ? `${row.left}px` : `${document.documentElement.clientWidth - row.right}px`;
        };
        toggle.addEventListener('change', () => {
            if (!toggle.checked) return dialog.open && dialog.close();
            if (dialog.open) return;
            placeDropdown();
            dialog.showModal();
            dialog.querySelector('a[href], button, input, [tabindex]:not([tabindex="-1"])')?.focus();
        });
        // Runs for Escape, cancel and programmatic close alike, so the checkbox and aria state never drift.
        dialog.addEventListener('close', () => {
            toggle.checked = false;
            syncControls(document, toggle);
            opener?.focus();
        });
        // The dialog itself is the full-screen or dropdown backdrop; only clicks outside its box count.
        dialog.addEventListener('click', (event) => {
            if (event.target !== dialog) return;
            const box = dialog.getBoundingClientRect();
            const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
            if (outside) dialog.close();
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
