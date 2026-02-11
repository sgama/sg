const purgecss = require("@fullhuman/postcss-purgecss");

const isProduction = process.env.HUGO_ENV === "production" || process.env.NODE_ENV === "production";

module.exports = {
    plugins: [
        require("autoprefixer"),
        ...(isProduction
            ? [
                purgecss({
                    content: [
                        "./layouts/**/*.html",
                        "./layouts/**/*.md",
                        "./content/**/*.md",
                        "./assets/**/*.js",
                        "./data/**/*.*",
                    ],
                    safelist: [
                        "open",
                        "ai-chat-open",
                        "disable-stars",
                        "chat-cta-chips",
                        "chat-cta-chip",
                    ],
                    defaultExtractor: (content) => content.match(/[A-Za-z0-9-_:/]+/g) || [],
                }),
            ]
            : []),
    ],
};
