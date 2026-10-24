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
                if (document.activeElement && menu.contains(document.activeElement)) document.activeElement.blur();
                setExpanded(false);
            });
        }
    },
};
