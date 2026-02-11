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
                        "ai-chat-open",
                        "disable-stars",
                        "chat-cta__chips",
                        "chat-cta__chip",
                        "chat-widget__window--open",
                    ],
                    defaultExtractor: (content) => content.match(/[A-Za-z0-9-_:/]+/g) || [],
                }),
            ]
            : []),
    ],
};
