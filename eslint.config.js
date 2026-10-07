import js from "@eslint/js";
import globals from "globals";

export default [
    {
        ignores: ["node_modules/**", "public/**", "resources/**", "reports/**",
            "coverage/**", ".wrangler/**", ".npm/**"],
    },
    js.configs.recommended,
    {
        files: ["**/*.{js,mjs}"],
        languageOptions: { ecmaVersion: "latest", sourceType: "module" },
        rules: {
            "no-unused-vars": ["error", {
                argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_",
                ignoreRestSiblings: true,
            }],
            "no-constant-condition": ["error", { checkLoops: false }],
        },
    },
    {
        files: ["assets/js/**/*.js"],
        languageOptions: { globals: globals.browser },
    },
    {
        files: ["functions/**/*.js"],
        languageOptions: { globals: globals.worker },
    },
    {
        files: ["scripts/**/*.mjs", "tests/**/*.mjs", "*.config.js"],
        languageOptions: { globals: globals.node },
    },
];
