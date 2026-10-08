# Test Suite Documentation

The RAG fixture includes 29 cases: technical regressions plus recruiter/HR
screening for background, location, contact, education, mentoring, stakeholders
and working style. Required negative cases cover unconfirmed start dates,
authorization, relocation, work arrangement, compensation, departure reasons,
direct reports, references and behavioral stories. These exercise abstention
against actual retrieved context, not invented candidate preferences.
One full comparison can now make up to 29 generation calls per model/repetition;
negative cases are excluded from source-hit and evidence-rate denominators.

Enterprise-grade test suite for the SG application using Node.js native test runner.

## Overview

This test suite follows industry best practices for modular, maintainable, and comprehensive testing. Tests are organized into logical suites with shared utilities, constants, and fixtures to eliminate duplication and improve maintainability.

## Structure

```text
tests/
├── unit/                    # Unit tests for individual modules
│   ├── ai-cli.test.mjs           # Offline evaluation and refresh CLI contracts
│   ├── ai-evaluation.test.mjs    # Model comparisons, failures and release gates
│   ├── ai-service.test.mjs       # AiService (embeddings, context, generation)
│   ├── background-blur.test.mjs  # Background image lifecycle
│   ├── chat-api.test.mjs         # /api/chat endpoint
│   ├── chat-stream.test.mjs      # Provider SSE normalization
│   ├── chat-widget.test.mjs      # Lifecycle, storage, scroll and client streams
│   ├── cloudflare-ai.test.mjs    # SDK retrieval and generation transport
│   ├── content-audit.test.mjs    # Front matter audit CLI
│   ├── corpus.test.mjs           # Ingestion, integrity and transport
│   ├── corpus-refresh.test.mjs   # Readiness and namespace activation
│   ├── deployment-cleanup.test.mjs # Retention, pruning and failure safety
│   ├── guardrails.test.mjs       # Security and safety checks
│   ├── log-service.test.mjs      # Persistence, retrieval and KV failures
│   ├── logs-api.test.mjs         # /api/logs endpoint
│   ├── local-ai-lifecycle.test.mjs # Compose teardown and owned-volume cleanup
│   ├── local-ai.test.mjs         # Local embeddings, cosine search and streaming
│   ├── makefile.test.mjs         # Native command wiring
│   ├── mocks.test.mjs            # Shared mock contracts
│   ├── rag-audit.test.mjs        # Offline question coverage, provenance and authoring gaps
│   ├── site.test.mjs             # Site browser script behavior
│   └── validation.test.mjs       # Request/history schemas and exact boundaries
└── helpers/                 # Shared test utilities
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
22.13+, or 24+; CI uses Node 24.

Coverage uses c8 with the native Node test runner, including unexecuted browser,
Functions, and script files rather than reporting only imported modules.
Outputs are `coverage/index.html`, `coverage/lcov.info`, and
`coverage/coverage-summary.json`; CI retains reports for 14 days.
Coverage is reported, not threshold-gated. Browser unit mocks are not a substitute
for real-browser coverage or accessibility tests.
Site and background-blur tests execute the original scripts in isolated Node VM
contexts with explicit DOM fixtures. Content-audit tests run the CLI against
temporary content trees and verify report contents and threshold exit codes.
AI CLI tests exercise evaluation reports and corpus refresh against temporary
corpora with injected fetch, including failures, force refresh and unchanged
corpus skipping. Widget lifecycle tests exercise submit, stop, offline errors,
session restoration and confirmed history clearing with isolated DOM fixtures.
These fixtures do not replace browser rendering or accessibility verification.
Failure-path assertions live with their owning module suites, not separate
failure-only files. Widget tests share one fixture for lifecycle and storage.
Cleanup failure tests verify invalid inventories, pagination cursors, snapshot
mismatches and mutation acknowledgements prevent unsafe continuation, with CLI
transport injected for offline checks. Storage tests assert warnings and fallbacks
when browser storage fails; validation tests cover exact context and aggregate
history boundaries.
Evaluation failure tests verify unpriced usage, failed streams and incomplete
cost reports. Corpus integrity tests cover tampered metadata/IDs, invalid
configuration and concurrent activation edits. Persistence failure tests assert
KV errors are logged, missing records are omitted, and failed log writes do not
break answer delivery; logs API read failures return an explicit 500.

Make validation targets suppress recipe echo and stream native tool output,
preserving warnings, errors, and exit codes without filtering. Tests use Node's
`spec` reporter for shorter output than TAP with failure details intact.
`make test TEST_REPORTER=tap` (or `make ai-test TEST_REPORTER=tap`) selects TAP.
ESLint is silent on success, and c8 prints its native coverage summary.

Make and npm test/coverage commands use Node's native 30-second test timeout.
Files use Node's default parallel execution; console output need not be alphabetical.
Test cases and nested suites are ordered alphabetically by name,
case-insensitively; maintain that order when adding tests.
CLI subprocess tests also use a 10-second `spawnSync` timeout and assert that no
spawn error occurred, so a timeout cannot count as an expected command failure.

Cloudflare contract tests run the installed SDK with injected fetch and native
`Request`/`Response` objects. They verify Pages routes, terminating pagination,
preview-only force deletion, Vectorize payload limits and mutation readiness.
Evaluation fetch injection covers embedding, retrieval and generation, not just
generation. No Cloudflare credentials or network calls are needed.
Embedding contracts assert the literal model path, including unencoded slashes.
The shared embedding helper uses the SDK's native `post` method because SDK 7's
generated `ai.run` route encodes model slashes that Workers AI rejects.
Local GPU tests mock Ollama HTTP and Docker CLI boundaries; normal unit tests
do not start containers or download models. `make ai-local-validate` is the
explicit real-GPU integration check, separate from CI and cloud release gates.
Tests also exercise TEI BGE requests, replay provenance validation, stopping
embeddings before generation, and hybrid Cloudflare generation through injected
fetch. Hybrid tests never make paid calls or start the local generation service.
Retrieval evidence tests distinguish document hits from facts in bounded context,
exclude source-header terms, and reject forged evidence scores at release gates.
RAG audit tests use temporary content to exercise source drift, incomplete
question coverage, authoring warnings and invalid provenance without inference.

KV mocks reject writes unless `put` is explicitly configured. Use a test-scoped
`t.mock.fn` to assert write arguments and counts. Stream helpers use native
`Response.text()` for UTF-8 decoding and error propagation.

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

Retrieved-context evaluations include negative questions with their actual
retrieved passages; source hit-rate excludes unlabeled negatives. Version-2
retrieval reports must include every case. Model answer checks are substring
regressions, not semantic accuracy. Source headers preserve excerpt identity and
URLs within the context budget. Refresh scenarios use separate fixtures so a
failure names its specific activation/skip/error path.

Logs API tests verify intentionally public access without credentials or an admin
secret, along with pagination, method restrictions, and no-store headers.
Authentication is temporarily disabled for demonstration.

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
