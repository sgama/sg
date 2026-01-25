module.exports = {
    content: [
        "./public/**/*.html",
        "./public/**/*.js",
    ],

    defaultExtractor: (content) => {
        // Comprehensive extractor for Hugo, Tailwind, Alpine.js
        const broadMatches = content.match(/[^<>"'`\s.()]*[^<>"'`\s.():]/g) || [];
        const innerMatches = content.match(/(?<=class=["'`]).*?(?=["'`])/g) || [];
        return broadMatches.concat(innerMatches);
    },

    safelist: {
        standard: [
            // Core state classes
            'active', 'open', 'show', 'hidden', 'block', 'flex', 'grid',
            'dark', 'light',

            // Prose (markdown content)
            'prose', 'prose-slate', 'prose-invert',

            // Common utilities
            'max-w-prose', 'mx-auto', 'container',
        ],

        deep: [
            // Blowfish components
            /^article/,
            /^card/,
            /^badge/,
            /^button/,
            /^alert/,
            /^timeline/,

            // Syntax highlighting
            /^chroma/,
            /^highlight/,

            // Icons
            /^icon/,
        ],

        greedy: [
            // Alpine.js attributes
            /^x-/,
            /^\[x-/,

            // Data attributes
            /^data-/,
            /^\[data-/,

            // ARIA attributes  
            /^aria-/,

            // Tailwind variants
            /^(sm|md|lg|xl|2xl):/,
            /^(hover|focus|active|disabled|visited|checked|group-hover|peer-):/,
            /^dark:/,

            // Transitions & animations
            /^transition/,
            /^duration/,
            /^ease/,
            /^animate/,
            /^scale/,
            /^rotate/,
            /^translate/,
            /^opacity/,

            // Appearance switching
            /appearance/,
            /theme/,
        ]
    },

    keyframes: true,
    fontFace: true,
    variables: true,
};
