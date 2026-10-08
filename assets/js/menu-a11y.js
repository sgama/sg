(() => {
    'use strict';

    const toggleSelector = 'button[data-menu-toggle]';

    function controlsFor(checkbox) {
        return Array.from(document.querySelectorAll(toggleSelector)).filter((button) => button.dataset.menuToggle === checkbox.id);
    }

    function syncControls(checkbox) {
        controlsFor(checkbox).forEach((button) => button.setAttribute('aria-expanded', String(checkbox.checked)));
    }

    function setupMenuButtons() {
        const checkboxes = new Set();
        document.querySelectorAll(toggleSelector).forEach((button) => {
            const checkbox = document.getElementById(button.dataset.menuToggle);
            if (!checkbox || checkbox.type !== 'checkbox') {
                console.error('Menu toggle checkbox missing:', button.dataset.menuToggle);
                return;
            }
            button.addEventListener('click', () => {
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            });
            if (!checkboxes.has(checkbox)) {
                checkboxes.add(checkbox);
                checkbox.addEventListener('change', () => syncControls(checkbox));
                syncControls(checkbox);
            }
        });
    }

    function setupMobileMenuDismissal() {
        const toggle = document.getElementById('mobile-menu-toggle');
        const dialog = document.getElementById('mobile-menu-dialog');
        if (!toggle || !dialog) return;
        const opener = controlsFor(toggle).find((button) => !dialog.contains(button));
        const close = () => {
            toggle.checked = false;
            syncControls(toggle);
        };
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && toggle.checked) {
                close();
                opener?.focus();
            }
        });
        document.addEventListener('click', (event) => {
            if (!toggle.checked || event.target === toggle || dialog.contains(event.target)) return;
            if (event.target.closest(toggleSelector)) return;
            close();
        });
    }

    function setupDesktopDropdowns() {
        document.querySelectorAll('.nested-menu').forEach((menu) => {
            const trigger = menu.querySelector('[aria-haspopup]');
            if (!trigger) return;
            const setExpanded = (expanded) => trigger.setAttribute('aria-expanded', String(expanded));
            menu.addEventListener('mouseenter', () => setExpanded(true));
            menu.addEventListener('mouseleave', () => setExpanded(false));
            menu.addEventListener('focusin', () => setExpanded(true));
            menu.addEventListener('focusout', (event) => {
                if (!menu.contains(event.relatedTarget)) setExpanded(false);
            });
            menu.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    if (document.activeElement && menu.contains(document.activeElement)) document.activeElement.blur();
                    setExpanded(false);
                }
            });
        });
    }

    function init() {
        setupMenuButtons();
        setupMobileMenuDismissal();
        setupDesktopDropdowns();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
