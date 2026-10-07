# Test Suite Documentation

Enterprise-grade test suite for the SG application using Node.js native test runner.

## Overview

This test suite follows industry best practices for modular, maintainable, and comprehensive testing. Tests are organized into logical suites with shared utilities, constants, and fixtures to eliminate duplication and improve maintainability.

## Structure

```text
tests/
├── unit/                    # Unit tests for individual modules
│   ├── ai-service.test.mjs       # AiService (embeddings, context, generation)
│   ├── ai-evaluation.test.mjs    # Model comparisons and release gates
│   ├── corpus.test.mjs           # Versioned ingestion and transport
│   ├── corpus-refresh.test.mjs   # Index readiness and deployment namespace activation
│   ├── deployment-cleanup.test.mjs # Rollback retention and safe vector pruning
│   ├── chat-widget.test.mjs      # Lazy lifecycle, scroll following, and client streams
│   ├── chat-api.test.mjs         # /api/chat endpoint
│   ├── chat-stream.test.mjs      # Provider SSE normalization
│   ├── guardrails.test.mjs       # Security and safety checks
│   ├── history.test.mjs          # Schema validation
│   ├── log-service.test.mjs      # LogService (persistence, retrieval)
│   └── logs-api.test.mjs         # /api/logs endpoint
└── helpers/                 # Shared test utilities
    ├── index.mjs                 # Re-exports all helpers
    ├── data.mjs                  # Constants, fixtures, and test data builders
    └── mocks.mjs                 # Mock factories
```

## Running Tests

Generation defaults to GLM-4.7-Flash with thinking disabled, selected from a
shared model registry. The server normalizes
OpenAI-style content deltas to `data: {"response":"..."}` events for the widget
and KV logger, omits reasoning, and forwards the final Workers AI usage summary.
Empty or malformed responses emit an error event rather than silently succeeding.
Stream tests cover fragmented UTF-8, legacy events, and provider completion events.

```bash
# Run all tests
npm test

# Run specific test file
node --test tests/unit/ai-service.test.mjs

# Run with coverage (if configured)
npm run test:coverage

# Watch mode
node --test --watch tests/unit/
```

### JavaScript lint and coverage

```bash
make lint
make lint-fix
make coverage
make test TEST_REPORTER=tap
```

ESLint's recommended correctness rules cover browser scripts, Workers/Functions,
Node scripts, tests, and tooling configuration with environment-specific globals.
Generated assets and dependency directories are ignored. The pre-commit hook
lints changed JavaScript; CI lints the complete repository before paid ingestion.
Install dependencies with `npm ci` first. ESLint 10 requires Node 20.19+ or
22.13+; CI uses Node 22.

Coverage uses c8 with the native Node test runner, including unexecuted browser,
Functions, and script files rather than reporting only imported modules.
Outputs are `coverage/index.html`, `coverage/lcov.info`, and
`coverage/coverage-summary.json`; CI retains reports for 14 days.
Coverage is reported, not threshold-gated. Browser unit mocks are not a substitute
for real-browser coverage or accessibility tests.

Make validation targets suppress recipe echo and stream native tool output,
preserving warnings, errors, and exit codes without filtering. Tests use Node's
`spec` reporter for shorter output than TAP with failure details intact.
`make test TEST_REPORTER=tap` (or `make ai-test TEST_REPORTER=tap`) selects TAP.
ESLint is silent on success, and c8 prints its native coverage summary.

AI-service, chat API, and stream error-path tests capture expected `console.error` calls with
test-scoped `t.mock.method` and assert their arguments and call counts.
Node restores the mocks after each test. Keep these tests sequential within a
process; production logging and unrelated test output remain unchanged.

## Test Organization

Tests use **nested test suites** for better organization and readability:

```javascript
test('AiService', async (t) => {
  await t.test('getEmbeddings', async (t) => {
    await t.test('returns first vector from AI response', async () => {
      // test implementation
    });

    await t.test('returns null when AI throws', async () => {
      // test implementation
    });
  });
});
```

### Benefits of Nested Suites

- **Clear hierarchy**: Tests are grouped by feature/method
- **Better error messages**: Failures show the full test path
- **Easier maintenance**: Related tests are physically grouped
- **Selective running**: Can focus on specific suites during development

## Shared Utilities

Shared application settings, prompt/context construction, and application errors live in
`functions/_lib/application.js`; request schemas and guardrail checks live in
`functions/_lib/validation.js`. SSE creation and provider normalization share
`functions/_lib/chat-stream.js`.

Corpus parsing stays in `scripts/lib/corpus.mjs`; ingestion, mutation readiness,
and namespace activation share `scripts/lib/corpus-deployment.mjs`. CLI scripts
import these libraries rather than importing one another. Test helpers are
imported directly from `helpers/data.mjs` and `helpers/mocks.mjs`.

Source-content regression tests are grouped by responsibility: published facts
and chunk availability in `corpus.test.mjs`, prompt construction in
`ai-service.test.mjs`, and answer scoring/release gates in `ai-evaluation.test.mjs`.

### Constants (`helpers/data.mjs`)

Centralized test constants ensure consistency and make updates easier:

```javascript
import { VALIDATION, PAGINATION, TIMESTAMPS, URLS, SAMPLE_DATA } from '../helpers/data.mjs';

// Use in tests
assert.equal(query.length, VALIDATION.MAX_QUERY_LENGTH);
assert.equal(limit, PAGINATION.DEFAULT_LIMIT);
```

**Available constants:**

- `VALIDATION`: Max lengths and limits for input validation
- `PAGINATION`: Default and max pagination values
- `TIMESTAMPS`: Fixed timestamps for deterministic tests
- `URLS`: Test origins and API endpoints
- `SAMPLE_DATA`: Common test data (vectors, queries, context)

### Mock Factories (`helpers/mocks.mjs`)

Reusable factory functions for creating mock objects:

```javascript
import { makeEnv, makeKv, createContext, makeStream } from '../helpers/mocks.mjs';

// Create mock AI environment
const env = makeEnv({
  aiRun: async () => ({ data: [[0.1, 0.2, 0.3]] }),
  vectorizeQuery: async () => ({ matches: [...] }),
});

// Create mock KV namespace
const kv = makeKv({
  keys: [...],
  cursor: 'next-page',
  list_complete: false,
});

// Create mock request context
const ctx = createContext({
  method: 'POST',
  body: { query: 'test' },
  env: { AI: {...} },
});
```

### Fixtures & Builders (`helpers/data.mjs`)

Pre-built test data and builder patterns for complex objects:

```javascript
import { buildHistory, buildKvKey, buildVectorizeResult, FIXTURES } from '../helpers/data.mjs';

// Use pre-built fixtures
const history = FIXTURES.VALID_HISTORY;
const usage = FIXTURES.USAGE_STATS;

// Build custom test data
const customHistory = buildHistory(
  { role: 'user', content: 'Hi' },
  { role: 'assistant', content: 'Hello' }
);

const kvKey = buildKvKey({
  query: 'test query',
  response: 'test response',
  timestamp: '2026-01-01T00:00:00.000Z',
});
```

## Testing Patterns

### Async Stream Testing

```javascript
import { makeStream, drainStream } from '../helpers/mocks.mjs';

test('handles SSE streams correctly', async () => {
  const stream = makeStream(
    'data: {"response":"Hello"}\n',
    'data: {"response":" world"}\n',
    'data: [DONE]\n'
  );

  const output = await drainStream(stream);
  assert.match(output, /Hello world/);
});
```

### Deterministic Timestamps

```javascript
import { makeTimestamp } from '../helpers/mocks.mjs';
import { TIMESTAMPS } from '../helpers/data.mjs';

const now = makeTimestamp(TIMESTAMPS.FIXED_TS);

// Use in tests
const result = await service.save(kv, 'query', stream, null, { now });
assert.equal(result.timestamp, TIMESTAMPS.FIXED_TS);
```

### Request Context Testing

```javascript
import { createContext } from '../helpers/mocks.mjs';
import { URLS } from '../helpers/data.mjs';

test('handles CORS correctly', async () => {
  const response = await onRequest(createContext({
    method: 'OPTIONS',
    origin: URLS.ALLOWED_ORIGIN,
    url: `${URLS.TEST_API_ENDPOINT}/chat`,
  }));

  assert.equal(response.headers.get('Access-Control-Allow-Origin'), URLS.ALLOWED_ORIGIN);
});
```

## Best Practices

### ✅ DO

- **Use shared helpers**: Import from `helpers/` instead of duplicating
- **Use nested suites**: Group related tests for better organization
- **Use constants**: Reference shared constants instead of magic values
- **Test edge cases**: Empty strings, null values, malformed input
- **Test error paths**: Not just happy paths
- **Keep tests focused**: One assertion per logical concept
- **Use descriptive names**: Test names should explain what they verify

### ❌ DON'T

- **Duplicate factories**: Always use shared mock factories
- **Hard-code values**: Use constants for repeated values
- **Skip error cases**: Test failure modes thoroughly
- **Create global state**: Each test should be independent
- **Test implementation details**: Focus on behavior, not internals

## Coverage Goals

Aim for:

- **Line coverage**: > 90%
- **Branch coverage**: > 85%
- **Function coverage**: > 95%

Focus on meaningful coverage, not just numbers.

## Adding New Tests

1. **Choose the right location**: Unit tests go in `tests/unit/`
2. **Import helpers**: Use shared utilities from `helpers/`
3. **Follow naming convention**: `module-name.test.mjs`
4. **Use nested suites**: Organize tests hierarchically
5. **Add JSDoc**: Document complex test scenarios
6. **Update this README**: If introducing new patterns

### Example Template

```javascript
/**
 * Unit tests for NewModule
 * Brief description of what this module does
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NewModule } from '../../functions/_lib/new-module.js';
import { makeEnv } from '../helpers/mocks.mjs';
import { SAMPLE_DATA } from '../helpers/data.mjs';

test('NewModule', async (t) => {
  await t.test('methodName', async (t) => {
    await t.test('does something when condition', async () => {
      // Arrange
      const module = new NewModule(makeEnv());

      // Act
      const result = await module.methodName(SAMPLE_DATA.SAFE_QUERY);

      // Assert
      assert.equal(result, expectedValue);
    });
  });
});
```

## Continuous Integration

Tests run automatically on:

- Pull request creation
- Commits to main branch
- Before deployment

Ensure all tests pass before merging.

## Troubleshooting

### Tests failing locally but passing in CI

- Check Node.js version matches CI environment
- Ensure all dependencies are installed
- Clear any caches: `rm -rf node_modules && npm install`

### Slow tests

- Use `--test-only` flag to run specific tests during development
- Consider parallelization for independent test suites
- Profile with `--test-reporter=spec` for detailed timing

### Flaky tests

- Usually caused by timing issues or shared state
- Use fixed timestamps from `TIMESTAMPS` constant
- Ensure tests are independent (no shared state)
- Avoid real network calls (use mocks)

## Resources

- [Node.js Test Runner Docs](https://nodejs.org/api/test.html)
- [Assert API](https://nodejs.org/api/assert.html)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)

## Contributing

When contributing tests:

1. Follow existing patterns and conventions
2. Use shared helpers and constants
3. Write descriptive test names
4. Test both success and failure paths
5. Keep tests focused and independent
6. Update documentation as needed

---

**Last updated**: April 26, 2026
