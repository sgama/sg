# Shared AI Core and Worker Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move runtime-neutral AI logic to `shared/ai/` and fix cache-shape and cancellation handling without changing chat contracts.

**Architecture:** `shared/ai/` owns portable config, prompts, retrieval, stream normalization, metrics, and answer policy. The Worker keeps HTTP and Cloudflare-specific errors/adapters; scripts and evals import the shared implementation directly.

**Tech Stack:** JavaScript ES modules, JSDoc typechecking, Cloudflare Workers/Hono, Node 24 native tests, Make targets.

**Spec:** [2026-11-20 JavaScript Architecture and Reliability Design](../specs/2026-11-20-js-architecture-design.md)

## Global Constraints

- Shared code must not import Hono, Cloudflare bindings/SDK, Node-only APIs, or modules under `functions/`, `scripts/`, or `assets/`.
- Do not add a compatibility re-export layer.
- Keep chat JSON input, SSE schema/order/terminal `[DONE]`, corpus schemas/IDs/hashes/namespaces, and existing provider-failure handling stable.
- A disconnected request must stop paid model work and must not write to a closed response; a deadline must end with the existing error-event shape and `[DONE]`.
- Do not perform paid inference, deploy, or mutate/delete cloud resources; verification uses injected services, clients, and fixtures.
- Follow project commands through Make; add shared files to Worker and Node typechecking, formatter globs, and coverage inventory.

## Review Focus

- A Node/script import of shared logic must work without Worker globals; pin this in `tests/unit/shared-ai.test.mjs` and Node typechecking (Task 1).
- The Worker must still build against the same shared logic and keep its API contracts; pin this in `tests/unit/chat-api.test.mjs` and `make ai-build` (Task 1).
- A valid-JSON cache payload with a wrong shape must become a miss and be replaced by normal retrieval; pin this in `tests/unit/ai-service.test.mjs` (Task 2).
- Disconnects during rewrite, embedding, generation, or stream reading must stop work without logs or later SSE writes; pin these paths in `tests/unit/ai-service.test.mjs`, `tests/unit/chat-stream.test.mjs`, and `tests/unit/chat-api.test.mjs` (Task 3).
- A request deadline must terminate the stream without looking like a provider outage, while real provider failures retain their current behavior; pin both cases in `tests/unit/chat-api.test.mjs` and `tests/unit/ai-service.test.mjs` (Task 3).

---

### Task 1: Move runtime-neutral AI code and establish import direction

**Files:**

- Create: `shared/ai/application.js`, `shared/ai/answer-policy.js`, `shared/ai/prompts.js`, `shared/ai/retrieval.js`, `shared/ai/chat-stream.js`, `shared/ai/response-metrics.js`, `functions/_lib/worker-errors.js`, `tests/unit/shared-ai.test.mjs`
- Modify: `functions/_lib/{ai,chat-app,retrieval-cache,validation}.js`; `scripts/cleanup_vectors.mjs`; `scripts/lib/{corpus,corpus-contract,corpus-deployment,cloudflare-ai}.mjs`; `evals/rag-provider.mjs`; `tests/helpers/data.mjs`; affected `tests/unit/*.test.mjs`; `README.md`; `Makefile`; `package.json`; `tsconfig.json`; `tsconfig.scripts.json`
- Delete after migrating callers: `functions/_lib/{application,prompts,retrieval,chat-stream,response-metrics}.js`

**Interfaces:**

- `shared/ai/application.js` exports `AI_CONFIG`, `AI_MODELS`, `CONFIG`, `getModel`, `isValidEmbeddingVector`, `estimateCost`, `generationInput`, `contextualizationInput`, `contextualizedQueryFromResponse`, and `rewriteSearchQuery`.
- `shared/ai/answer-policy.js` exports `SAFE_NO_CONTEXT_MESSAGE` and `shouldAbstainForMissingContext(contextText, minimumChars = CONFIG.ABSTAIN.MIN_CONTEXT_CHARS)`.
- `functions/_lib/worker-errors.js` exports `AppError` and `requireVectorizeBinding`; `functions/_lib/validation.js` continues to own `ChatRequestSchema` and imports shared `CONFIG`.
- Move the other listed modules' existing exports unchanged. Production and evaluation use the same retrieval, prompts, stream normalizer, and metrics implementation.

- [ ] **Step 1: Write a failing shared-import test** in `tests/unit/shared-ai.test.mjs`. Import `getModel` and answer-policy exports from `shared/ai/`; assert a configured model is returned and empty/short context is rejected while adequate context is accepted. Update existing test imports to the new shared paths without changing their assertions.
- [ ] **Step 2: Run focused tests to verify the shared modules are missing**

Run: `node --test --test-timeout=30000 tests/unit/shared-ai.test.mjs tests/unit/application.test.mjs tests/unit/validation.test.mjs tests/unit/chat-stream.test.mjs`
Expected: FAIL at import resolution for the new `shared/ai/` paths.

- [ ] **Step 3: Move the modules and update every Worker, script, evaluation, and test caller**. Shared code may import `data/chat_ai.json`, but not code under `functions/`, `scripts/`, or `assets/`, Hono, Cloudflare SDK/bindings, or Node-only APIs. Split `AppError` and Vectorize binding checks into `worker-errors.js`; remove old files after all callers have moved. Do not add forwarding shims.
- [ ] **Step 4: Add shared files to both runtime typechecks and project inventories**: add `shared/**/*.js` to `tsconfig.json`, `tsconfig.scripts.json`, Makefile `PRETTIER_FILES`, and package c8 `include`; update README architecture text to name `shared/ai/`.
- [ ] **Step 5: Run cross-runtime validation**

Run: `make test`
Expected: PASS; Worker, script, and evaluation callers exercise the same shared implementations.

Run: `make typecheck`
Expected: PASS in Worker, Node/script, and browser environments.

Run: `make lint format-check ai-build`
Expected: PASS without paid inference or deployment.

- [ ] **Step 6: Commit the task**

```bash
git add -A -- shared/ai functions/_lib/application.js functions/_lib/worker-errors.js functions/_lib/validation.js functions/_lib/ai.js functions/_lib/chat-app.js functions/_lib/retrieval-cache.js functions/_lib/prompts.js functions/_lib/retrieval.js functions/_lib/chat-stream.js functions/_lib/response-metrics.js scripts/cleanup_vectors.mjs scripts/lib/corpus.mjs scripts/lib/corpus-contract.mjs scripts/lib/corpus-deployment.mjs scripts/lib/cloudflare-ai.mjs evals/rag-provider.mjs tests/helpers/data.mjs tests/unit/shared-ai.test.mjs tests/unit/corpus.test.mjs tests/unit/corpus-refresh.test.mjs tests/unit/chat-metrics.test.mjs tests/unit/validation.test.mjs tests/unit/corpus-deployment.test.mjs tests/unit/ai-cli.test.mjs tests/unit/cloudflare-ai.test.mjs tests/unit/ai-service.test.mjs tests/unit/application.test.mjs tests/unit/chat-stream.test.mjs tests/unit/corpus-content.test.mjs Makefile package.json tsconfig.json tsconfig.scripts.json README.md
git commit -m "refactor: share AI logic across runtimes"
```

### Task 2: Treat malformed retrieval-cache payloads as misses

**Files:**

- Modify: `functions/_lib/ai.js`
- Test: `tests/unit/ai-service.test.mjs`

**Interfaces:**

- The cache store contract stays `get(namespace, query) -> payload | null` and `put(namespace, query, payload)`; `AiService.retrieve()` validates the payload before using it.

- [ ] **Step 1: Add a failing test** named `a malformed cache payload falls through to retrieval and is replaced`. Return `{}` from `retrievalStore.get`, let the injected Vectorize/embedding path return a valid result, then assert retrieval succeeds and `put` stores the fresh result.
- [ ] **Step 2: Run the test to verify the current crash**

Run: `node --test --test-timeout=30000 --test-name-pattern='malformed cache payload' tests/unit/ai-service.test.mjs`
Expected: FAIL because the invalid cached `evidence` is dereferenced instead of retrieval being called.

- [ ] **Step 3: Validate the hit before use**. Accept only a non-null object with string `contextText` and array `evidence`; otherwise continue through normal retrieval and preserve the existing cache-write conditions.
- [ ] **Step 4: Run the cache and service tests**

Run: `node --test --test-timeout=30000 tests/unit/ai-service.test.mjs tests/unit/retrieval-cache.test.mjs`
Expected: PASS; cache I/O and malformed JSON remain fail-open.

- [ ] **Step 5: Commit the task**

```bash
git add functions/_lib/ai.js tests/unit/ai-service.test.mjs
git commit -m "fix: treat malformed retrieval cache entries as misses"
```

### Task 3: Distinguish cancellation from provider failure

**Files:**

- Modify: `functions/_lib/ai.js`, `functions/_lib/chat-app.js`, `shared/ai/chat-stream.js`
- Test: `tests/unit/ai-service.test.mjs`, `tests/unit/chat-api.test.mjs`, `tests/unit/chat-stream.test.mjs`

**Interfaces:**

- Extend `normalizeChatStream(stream, { onUsage, onFirstToken, metrics, signal })` with an optional abort signal; preserve existing callers when no signal is supplied.
- The request handler keeps the existing SSE error envelope and `[DONE]`; it distinguishes a disconnected request from its own deadline signal.

- [ ] **Step 1: Add failing cancellation tests**: abort during contextualization, embedding, generation startup, and a pending stream read; assert the reader/source is canceled, no further model call occurs, and no provider-failure log/event is emitted for a disconnect. Add a deadline case asserting the existing error envelope followed by `[DONE]` without outage logging; retain a real provider-failure case that logs once and follows current error behavior.
- [ ] **Step 2: Run the focused tests to verify current behavior**

Run: `node --test --test-timeout=30000 tests/unit/ai-service.test.mjs tests/unit/chat-api.test.mjs tests/unit/chat-stream.test.mjs`
Expected: FAIL because aborts are currently wrapped/logged as service failures and stream reads do not observe cancellation.

- [ ] **Step 3: Implement cancellation propagation**. In service catches, preserve the original error when the supplied signal is aborted. Make stream reading cancel its reader/source when aborted. In `chat-app.js`, do not log or write after client disconnect; for the deadline, write the existing safe error-event shape and terminal `[DONE]` without labeling it a provider outage.
- [ ] **Step 4: Run focused tests and complete offline acceptance**

Run: `node --test --test-timeout=30000 tests/unit/ai-service.test.mjs tests/unit/chat-api.test.mjs tests/unit/chat-stream.test.mjs`
Expected: PASS for abort phases, deadline termination, and real provider failures.

Run: `make lint format-check typecheck test ai-build`
Expected: PASS; no cloud credentials or paid inference are used.

- [ ] **Step 5: Commit the task**

```bash
git add functions/_lib/ai.js functions/_lib/chat-app.js shared/ai/chat-stream.js tests/unit/ai-service.test.mjs tests/unit/chat-api.test.mjs tests/unit/chat-stream.test.mjs
git commit -m "fix: distinguish request cancellation from AI outages"
```
