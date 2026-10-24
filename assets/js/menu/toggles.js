// Native buttons (`button[data-menu-toggle="<checkbox id>"]`) drive the theme's checkbox-based menus.
// These helpers keep each checkbox and every button that controls it in sync.
export const TOGGLE_SELECTOR = 'button[data-menu-toggle]';

export const controlsFor = (document, checkbox) =>
    Array.from(document.querySelectorAll(TOGGLE_SELECTOR)).filter((button) => button.dataset.menuToggle === checkbox.id);

export const syncControls = (document, checkbox) => {
    for (const button of controlsFor(document, checkbox)) button.setAttribute('aria-expanded', String(checkbox.checked));
};
