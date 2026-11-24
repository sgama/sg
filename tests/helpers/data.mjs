/**
 * Shared test constants and fixtures.
 */

export const URLS = {
    ALLOWED_ORIGIN: 'https://samsongama.com',
    DISALLOWED_ORIGIN: 'https://evil.com',
    TEST_API_ENDPOINT: 'https://example.com/api',
};

export const FIXTURES = {
    VALID_HISTORY: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello there' },
        { role: 'user', content: 'Tell me more' },
    ],
};
