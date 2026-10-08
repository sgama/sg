# Test Suite

Tests use Node's native runner. Make owns the runner commands, timeouts, tool checks, and environment wiring; npm test scripts delegate to Make. Offline tests use injected services and do not require Cloudflare credentials, perform inference, start containers, or deploy.

## Prerequisites and commands

Install dependencies with `make deps`. The complete unit suite and coverage require Node, npm, and Hugo because corpus and CLI tests query Hugo's published-page inventory. Individual suites that do not build corpora can run with Node alone. Use the Node version configured in [CI](../.github/workflows/main.yml); CI currently uses Node 24.

```bash
make test
npm test                         # Delegates to make test
make coverage
npm run test:coverage             # Delegates to make coverage
make test TEST_REPORTER=tap
make test-layouts
make lint format-check

# Focused suites; corpus tests still need Hugo
node --test --test-timeout=30000 tests/unit/corpus*.test.mjs
node --test --test-name-pattern='embedding' tests/unit/corpus-deployment.test.mjs
node --test --watch tests/unit/validation.test.mjs
```

Make supports `NODE`, `HUGO`, and `TEST_REPORTER` overrides for both tests and coverage. Unit tests have a 30-second per-test timeout; Hugo layout tests have a 120-second timeout. CLI subprocess tests separately use bounded spawn timeouts and assert spawn errors so a timeout cannot count as an expected failure.

Coverage uses c8 and includes unexecuted browser, Functions, and script files. It writes `coverage/index.html`, `coverage/lcov.info`, and `coverage/coverage-summary.json`. CI retains reports for 14 days. Coverage is reported, not threshold-gated; mocked browser tests are not substitutes for real-browser rendering or accessibility checks.

## Test ownership

Keep detailed behavior tests with the module that owns it. Keep cross-module regressions only where they verify integration rather than repeating the same isolated assertions. Files under `unit/` include offline contract and CLI integration tests as well as isolated unit tests.

| Suite | Responsibility |
| --- | --- |
| `content-normalization.test.mjs` | Markdown/HTML normalization, shortcode parsing, literal code, media removal, and heading boundaries |
| `source-provenance.test.mjs` | Hugo-owned URLs, slugs, explicit URLs, and permalinks |
| `section-chunks.test.mjs` | Bounded parent sections and deterministic child/parent linkage |
| `canonical-evidence.test.mjs` | Curated-to-public linkage, target validation, and runtime supplementation |
| `corpus.test.mjs` | Corpus assembly, embedding labels, source classification, configuration, and reproducibility |
| `corpus-content.test.mjs` | Repository content regressions: homepage prose, resume chronology/skills, and internal evidence |
| `corpus-contract.test.mjs` | Schema and semantic invariants, including edits with and without recomputed hashes |
| `corpus-deployment.test.mjs` | Embedding/upload transport, NDJSON, retries, cancellation, and pre-request validation |
| `corpus-refresh.test.mjs` | Mutation readiness, activation, unchanged-corpus handling, and concurrent configuration edits |
| `ai-cli.test.mjs` | Offline manifests, side-effect-safe imports, evaluation, and refresh CLI contracts |
| `ai-evaluation.test.mjs`, `local-ai.test.mjs`, `cloudflare-ai.test.mjs` | Evaluation gates and injected local/cloud transport contracts |
| `ai-service.test.mjs`, `chat-api.test.mjs`, `validation.test.mjs`, `guardrails.test.mjs` | Request validation, query contextualization, retrieval, generation, and error behavior |
| `chat-stream.test.mjs`, `chat-metrics.test.mjs` | Provider SSE normalization, usage, costs, and timing |
| `chat-widget.test.mjs`, `chat-render.test.mjs`, `site.test.mjs`, `background-blur.test.mjs` | Browser lifecycle, persistence, rendering boundaries, and site behavior |
| `log-service.test.mjs`, `logs-api.test.mjs` | KV persistence, pagination, public log access, and failures |
| `content-audit.test.mjs`, `rag-audit.test.mjs`, `favicons.test.mjs`, `makefile.test.mjs` | Content policies, provenance review, favicon command wiring, and build/test commands |
| `deployment-cleanup.test.mjs`, `local-ai-lifecycle.test.mjs` | Retention and owned-resource teardown safety |
| `integration/layouts.test.mjs` | Generated Hugo schema, public LLM index, image preloads, and theme settings |

This table groups responsibilities rather than serving as an exhaustive file inventory.

## Shared fixtures

[helpers/corpus.mjs](helpers/corpus.mjs) creates isolated temporary content trees with test-owned cleanup. Use `corpusFixture(t, files)` for synthetic source trees and `integrityFixture(t)` for a small corpus plus Wrangler configuration. It does not modify the repository's real content or indexes.

[helpers/mocks.mjs](helpers/mocks.mjs) provides injected AI, Vectorize, KV, request, and stream boundaries. [helpers/data.mjs](helpers/data.mjs) contains shared constants and builders. KV mocks reject writes unless `put` is explicitly configured; use test-scoped mocks to verify write arguments and counts.

```javascript
import { corpusFixture } from '../helpers/corpus.mjs';
import { buildCorpus } from '../../scripts/lib/corpus.mjs';

const root = await corpusFixture(t, {
    'content/page.md': '---\ntitle: Project\n---\nDeployment evidence.',
});
const corpus = await buildCorpus({ root });
```

Hugo layout tests use temporary content, assets, and output directories. They verify JSON-LD escaping/types, public-only index entries, preload parity, meta descriptions, progress settings, redirects, and absence of AdSense markup. Favicon unit tests mock ImageMagick commands; they verify wiring and errors, not actual encoded images or dimensions.

## Corpus and retrieval contracts

Normalization tests compare Markdown structure and preserve nested lists, indented/fenced code, literal angle brackets, inline shortcodes, balanced image destinations, and Setext headings. Corpus assembly tests check content-driven hashes, namespaces, and full-source-path IDs. Contract tests deliberately recompute hashes after malformed edits to exercise semantic invariants independently of hash integrity.

Parent expansion replaces narrow child evidence with its bounded section. Canonical expansion supplements curated facts with public evidence; unique internal facts remain in model context, while only public excerpts are displayed. Runtime/cloud/local tests verify deduplication, ordering, context budgets, and explicit missing-vector errors. Current chunks without section references require no parent lookup. Legacy records without an explicit record type are rejected by runtime retrieval.

Cloudflare contract tests use the installed SDK with injected fetch and native `Request`/`Response` objects. They verify actual payload bytes, model paths, pagination, mutations, readiness, and safe deletion acknowledgements. Local AI tests mock HTTP and container CLI boundaries. `make ai-local-validate` is the separate explicit real-GPU integration check; hybrid generation can make paid cloud calls and is not part of offline tests.

## Evaluation limits

[fixtures/ai-eval.json](fixtures/ai-eval.json) contains 34 technical and recruiter cases, including elliptical follow-ups, the role before Bitcomplete, deployment, and topic changes. Required negative cases cover unconfirmed availability, authorization, relocation, work arrangement, compensation, departure reasons, direct reports, references, and behavioral stories.

Retrieval reports record bounded standalone queries and gate labeled terms, expected sources, and facts in actual bounded context. Negative cases are excluded from source-hit and evidence-rate denominators. Source-header terms do not count as evidence. Version-2 reports must include every case; forged or incomplete evidence reports fail release gates.

Answer checks are substring regressions, not semantic accuracy measurements. A complete comparison can make up to 34 generation calls per model/repetition. Offline tests validate these contracts with injected responses; they do not establish live-model answer quality.

## Browser, streams, and logging

Browser suites execute source scripts with isolated DOM/VM fixtures. They cover submit/stop/retry, offline errors, confirmed history clearing, session restoration, public evidence, rendering boundaries, and metrics persistence without sending evidence or metrics as conversation history.

Stream tests cover fragmented UTF-8, current content deltas, rejection of response-only provider answers, reasoning omission, final usage summaries, stage ordering, and explicit errors after streaming starts. The current Workers binding terminal usage summary is accepted only after answer deltas. Local NDJSON is adapted to content deltas and aggregate usage rather than relying on a response-only fallback. Empty or malformed provider responses must not silently succeed. Use native `Response.text()` to test decoding and error propagation.

Use `t.mock.method` for expected logging and assert messages and call counts. Node restores test-scoped mocks. Keep tests that mutate process globals sequential within their file and restore those globals in cleanup. Log API tests currently verify intentionally public access, version-2 value reads, explicit rejection of unsupported records, pagination, method restrictions, and no-store headers; they do not assert an authentication requirement.

## Adding and maintaining tests

- Name suites after their owning module and use descriptive behavioral test names.
- Use nested subtests when they clarify related cases; nesting is not required.
- Cover success, boundaries, and failures without adding separate failure-only suites.
- Share fixtures when they genuinely remove duplication; do not hide important assertions behind abstractions.
- Keep synthetic values local unless multiple suites need the same contract constant.
- Preserve both integrity and semantic checks; they exercise different failure paths.
- Register cleanup for temporary files, mocks, and owned resources.
- Update this document when commands, prerequisites, or ownership change.

CI runs checks on pushes and pull requests targeting `develop`, before production deployment. For local failures, compare tool versions with CI, run the smallest affected suites, and inspect their output before reinstalling dependencies. Avoid real network calls and timing-dependent assertions in offline tests.
