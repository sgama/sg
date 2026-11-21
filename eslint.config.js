import js from '@eslint/js';
import globals from 'globals';

const SHARED_GLOBALS = {
    AbortController: 'readonly',
    AbortSignal: 'readonly',
    DOMException: 'readonly',
    EventSourceParserStream: 'readonly',
    Headers: 'readonly',
    ReadableStream: 'readonly',
    Request: 'readonly',
    Response: 'readonly',
    TextDecoderStream: 'readonly',
    TextEncoder: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    console: 'readonly',
    crypto: 'readonly',
    fetch: 'readonly',
    performance: 'readonly',
    queueMicrotask: 'readonly',
};

const SHARED_IMPORT_RESTRICTIONS = [
    { group: ['functions/*', 'functions/**/*'], message: 'Shared code cannot import from functions/' },
    { group: ['scripts/*', 'scripts/**/*'], message: 'Shared code cannot import from scripts/' },
    { group: ['assets/*', 'assets/**/*'], message: 'Shared code cannot import from assets/' },
    { group: ['hono', 'hono/*'], message: 'Shared code cannot import Hono' },
    { group: ['cloudflare', 'cloudflare/*'], message: 'Shared code cannot import Cloudflare SDK packages' },
    {
        group: [
            'node:*',
            'node:assert',
            'node:buffer',
            'node:child_process',
            'node:crypto',
            'node:fs',
            'node:http',
            'node:https',
            'node:net',
            'node:os',
            'node:path',
            'node:process',
            'node:stream',
            'node:timers',
            'node:tty',
            'node:url',
            'node:util',
            'node:worker_threads',
            'node:zlib',
        ],
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
