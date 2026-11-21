# Operational Scripts and CLI Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound corpus-cleanup risk, reconcile ambiguous domain mutations from observed state, preserve Wrangler line endings, and make the evaluation summary safe to import.

**Architecture:** Keep maintenance as thin CLI entrypoints around the existing script workflows. Run this plan after the shared-AI-core plan because both update `scripts/lib/corpus-deployment.mjs` and `scripts/cleanup_vectors.mjs`; do not have parallel writers edit those files.

**Tech Stack:** JavaScript ES modules, Cloudflare SDK 7, Node 24 native tests, injected fetch/fake clients, Make targets.

**Spec:** [2026-11-20 JavaScript Architecture and Reliability Design](../specs/2026-11-20-js-architecture-design.md)

## Global Constraints

- Do not perform paid inference, deploy, or mutate/delete cloud resources; use fake clients and injected/mock fetch only.
- Preserve cleanup dry-run and retention semantics, CLI flags/output, and corpus schemas, IDs, hashes, and namespaces.
- Reconcile remote mutation state; never blindly retry a Pages detach or Worker attach after an ambiguous error.
- Check the live and previous namespace before each 20-ID delete request, but retain serialized manual-writer operations because this is not a distributed lock.
- Preserve the input Wrangler line-ending convention and unrelated configuration bytes.
- Use installed SDK signatures, Make command conventions, and test-first changes; do not add dependencies.

## Review Focus

- A namespace changes after one cleanup guard: at most the just-submitted 20-ID batch may be deleted before the next check stops cleanup (`tests/unit/vector-cleanup.test.mjs`, Task 1).
- Pages or Worker mutation applies remotely and then throws: reconcile state and do not duplicate or reverse a successful move (`tests/unit/domain-cutover.test.mjs`, Task 2).
- A domain state lookup fails or finds a conflicting/unexpected owner: fail closed with actionable recovery details and preserve both causes (`tests/unit/domain-cutover.test.mjs`, Task 2).
- A CRLF Wrangler file is updated: recognize `[vars]`, insert settings with CRLF, and preserve the rest byte-for-byte (`tests/unit/corpus-refresh.test.mjs`, Task 3).
- The summarizer is imported with no `process.argv[1]` and run directly with a report: import succeeds and CLI output stays stable (`tests/unit/ai-evaluation.test.mjs`, Task 4).

---

### Task 1: Check cleanup namespaces before every delete batch

**Files:**

- Modify: `scripts/cleanup_vectors.mjs`, `README.md`
- Test: `tests/unit/vector-cleanup.test.mjs`

**Interfaces:**

- Preserve `cleanupVectors({ client, accountId, worker, indexName, dryRun, progress })` and the existing CLI `--dry-run` contract.
- Keep `ID_BATCH_SIZE` at 20; before each `deleteByIDs` call compare both current namespace fields with the initial live/previous pair.

- [ ] **Step 1: Tighten the regression test** named `a namespace change is checked before each delete batch and stops after one stale batch`. Change the fixture so the first per-batch lookup is unchanged and the next reports a namespace change; assert that only 20 IDs were deleted and cleanup then rejects.
- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-timeout=30000 --test-name-pattern='namespace change' tests/unit/vector-cleanup.test.mjs`
Expected: FAIL because the existing code allows 500 deletions between namespace checks.

- [ ] **Step 3: Check active namespaces before every delete request** in `scripts/cleanup_vectors.mjs`. Remove the 25-batch interval while keeping the existing stale-ID snapshot, batch size, fail-closed behavior, dry run, and retention set.
- [ ] **Step 4: Correct the operational wording** in the source comment and README: checks happen before each delete request and limit detected changes to one already-submitted batch, but do not form a distributed lock; manual namespace writers must remain outside the serialized maintenance window.
- [ ] **Step 5: Run cleanup tests**

Run: `node --test --test-timeout=30000 tests/unit/vector-cleanup.test.mjs`
Expected: PASS for per-batch guards, dry-run, retention, SDK calls, and mutation failures.

- [ ] **Step 6: Commit the task**

```bash
git add scripts/cleanup_vectors.mjs tests/unit/vector-cleanup.test.mjs README.md
git commit -m "fix: check corpus namespaces before each cleanup batch"
```

### Task 2: Reconcile ambiguous domain cutover mutations

**Files:**

- Modify: `scripts/cutover_domains.mjs`
- Test: `tests/unit/domain-cutover.test.mjs`

**Interfaces:**

- Keep `cutoverDomains({ client, accountId, project, worker, zone, dryRun, log })` and the existing result shape for successful moves.
- Add an internal `readDomainState(client, accountId, project, hostname)` that returns Pages attachment state and matching Worker services. Use `pages.projects.domains.get(hostname, { account_id, project_name })` (only SDK 404 means not attached) and iterate `workers.domains.list({ account_id })`, filtering by exact hostname.
- Preserve the original mutation error as the primary cause. If reconciliation or restoration also fails, include those failures and a concrete manual recovery action. Fail closed on read errors, conflicting ownership, or a Worker service other than the requested one.

- [ ] **Step 1: Extend the fake-client tests** for: detach rejected before effect (Pages still attached, propagate original error without another mutation); detach rejected after effect (restore Pages); attach rejected before effect (restore Pages); attach rejected after effect (recognize the intended Worker and report the hostname moved); and reconciliation failure or unexpected Worker owner (fail closed and retain causes). Keep the existing successful move and failed-restore tests.
- [ ] **Step 2: Run the new state tests to verify they fail**

Run: `node --test --test-timeout=30000 --test-name-pattern='ambiguous|reconcil|before effect|after effect' tests/unit/domain-cutover.test.mjs`
Expected: FAIL because the current script neither reads domain state nor handles a thrown Pages detach.

- [ ] **Step 3: Implement state-based recovery** in `scripts/cutover_domains.mjs`. After a detach or attach error, inspect both providers before deciding whether to stop, count the move as complete, restore Pages, or report manual recovery. Never retry a mutation solely because its response timed out.
- [ ] **Step 4: Add an installed-SDK/mock-fetch contract test** proving Pages `get` and Worker `list` use the documented account/project requests; keep all other state-machine branches on fake clients.
- [ ] **Step 5: Run domain cutover tests**

Run: `node --test --test-timeout=30000 tests/unit/domain-cutover.test.mjs`
Expected: PASS for successful moves, dry run, before/after-effect errors, failed recovery, conflicting ownership, and SDK request shape.

- [ ] **Step 6: Commit the task**

```bash
git add scripts/cutover_domains.mjs tests/unit/domain-cutover.test.mjs
git commit -m "fix: reconcile domain cutover state after API errors"
```

### Task 3: Preserve CRLF when activating a corpus namespace

**Files:**

- Modify: `scripts/lib/corpus-deployment.mjs`
- Test: `tests/unit/corpus-refresh.test.mjs`

**Interfaces:**

- Keep `setCorpusNamespace(config, namespace, previousNamespace)` and the existing validation/duplicate-setting behavior.
- Recognize `[vars]` with either LF or CRLF and use the input's newline convention for inserted namespace settings; do not normalize unrelated bytes.

- [ ] **Step 1: Add a failing test** named `namespace activation preserves CRLF line endings when inserting settings`. Supply CRLF config and assert the resulting active and previous namespace lines use CRLF, unrelated bindings are unchanged, and no bare LF was introduced.
- [ ] **Step 2: Run the CRLF test to verify it fails**

Run: `node --test --test-timeout=30000 --test-name-pattern='CRLF' tests/unit/corpus-refresh.test.mjs`
Expected: FAIL because the parser does not match the captured `[vars]\r` header.

- [ ] **Step 3: Recognize the section header and preserve line endings** in `setCorpusNamespace`. Normalize only the header comparison; choose the insertion newline from the supplied config and leave existing content untouched.
- [ ] **Step 4: Run corpus refresh tests**

Run: `node --test --test-timeout=30000 tests/unit/corpus-refresh.test.mjs`
Expected: PASS for LF/CRLF activation, concurrent config protection, and refresh behavior.

- [ ] **Step 5: Commit the task**

```bash
git add scripts/lib/corpus-deployment.mjs tests/unit/corpus-refresh.test.mjs
git commit -m "fix: preserve Wrangler config line endings"
```

### Task 4: Guard the evaluation summarizer with the shared CLI helper

**Files:**

- Modify: `scripts/summarize_ai_eval.mjs`
- Test: `tests/unit/ai-evaluation.test.mjs`

**Interfaces:**

- Keep the exported synchronous `summarize(report)` return value and the current successful CLI output.
- Define a promise-returning `main(reportPath = process.argv[2])` and call `runIfMain(import.meta.url, main, 'AI evaluation summary failed')` from `scripts/lib/cli.mjs`.

- [ ] **Step 1: Add tests** named `summarizer imports when process.argv[1] is unset` and `summarizer CLI preserves the report output`. Use a `node -e` child process for the first; use a temporary report file and invoke the script directly for the second.
- [ ] **Step 2: Run the tests to verify the import case fails**

Run: `node --test --test-timeout=30000 --test-name-pattern='summarizer' tests/unit/ai-evaluation.test.mjs`
Expected: FAIL because `pathToFileURL(undefined)` throws during module evaluation.

- [ ] **Step 3: Move entrypoint work into `main`** and use `runIfMain`; retain `summarize()` and byte-for-byte successful output.
- [ ] **Step 4: Run evaluation and CLI tests**

Run: `node --test --test-timeout=30000 tests/unit/ai-evaluation.test.mjs tests/unit/cli.test.mjs`
Expected: PASS for import safety, shared entrypoint error handling, summary calculation, and command output.

- [ ] **Step 5: Commit the task**

```bash
git add scripts/summarize_ai_eval.mjs tests/unit/ai-evaluation.test.mjs
git commit -m "fix: make evaluation summary safe to import"
```

### Plan acceptance

After Plan 1 is complete, run the focused operations suites together:

```bash
node --test --test-timeout=30000 tests/unit/vector-cleanup.test.mjs tests/unit/domain-cutover.test.mjs tests/unit/corpus-refresh.test.mjs tests/unit/ai-evaluation.test.mjs tests/unit/cli.test.mjs
```

Expected: PASS offline; no production API calls. Full-tree acceptance runs once after all three plans reconcile.
