import js from '@eslint/js';
import globals from 'globals';

const SHARED_GLOBALS = {
    AbortController: 'readonly',
    AbortSignal: 'readonly',
    DOMException: 'readonly',
    ReadableStream: 'readonly',
    TextDecoderStream: 'readonly',
    TextEncoder: 'readonly',
    TransformStream: 'readonly',
    console: 'readonly',
    crypto: 'readonly',
    performance: 'readonly',
    queueMicrotask: 'readonly',
};

const SHARED_IMPORT_RESTRICTIONS = [
    {
        group: ['**/functions/**', '**/functions/*', 'functions/**', 'functions/*'],
        message: 'Shared code cannot import from functions/',
    },
    {
        group: ['**/scripts/**', '**/scripts/*', 'scripts/**', 'scripts/*'],
        message: 'Shared code cannot import from scripts/',
    },
    {
        group: ['**/assets/**', '**/assets/*', 'assets/**', 'assets/*'],
        message: 'Shared code cannot import from assets/',
    },
    { group: ['hono', 'hono/*'], message: 'Shared code cannot import Hono' },
    { group: ['cloudflare', 'cloudflare/*'], message: 'Shared code cannot import Cloudflare SDK packages' },
    { regex: '^eventsource-parser/(?!stream$).*$', message: 'Shared code cannot import non-shared EventSource parser packages' },
    {
        regex: '^(?:node:)?(?:assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|fs/promises|http|http2|https|inspector|module|net|os|path(?:/posix|/win32)?|perf_hooks|process|punycode|querystring|readline|repl|stream(?:/consumers|/promises|/web)?|string_decoder|sys|timers(?:/promises)?|tls|trace_events|tty|url|util(?:/types)?|v8|vm|wasi|worker_threads|zlib)$',
        message: 'Shared code cannot import Node built-ins',
    },
];

export default [
    {
        ignores: ['node_modules/**', 'public/**', 'resources/**', 'reports/**', 'coverage/**', '.wrangler/**', '.npm/**'],
    },
    { linterOptions: { reportUnusedDisableDirectives: 'error' } },
    js.configs.recommended,
    {
        files: ['**/*.{js,mjs}'],
        languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        rules: {
            'no-var': 'error',
            'no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    ignoreRestSiblings: true,
                },
            ],
            'no-constant-condition': ['error', { checkLoops: false }],
        },
    },
    {
        files: ['assets/js/**/*.js'],
        languageOptions: { globals: { ...globals.browser, ...globals.serviceworker } },
    },
    {
        files: ['functions/**/*.js'],
        languageOptions: { globals: { ...globals.serviceworker, ...globals.node } },
    },
    {
        files: ['shared/**/*.js'],
        languageOptions: { globals: SHARED_GLOBALS },
        rules: {
            'no-restricted-imports': ['error', { patterns: SHARED_IMPORT_RESTRICTIONS }],
        },
    },
    {
        files: ['evals/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs', '*.config.js'],
        languageOptions: { globals: globals.node },
    },
];
