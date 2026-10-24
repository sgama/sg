/** Starts the CSS starfield once the page is idle; the stylesheet gates the animation on this class. */
export const starfield = {
    name: 'starfield',
    phase: 'idle',
    init({ document }) {
        document.documentElement.classList.add('stars-running');
    },
};
