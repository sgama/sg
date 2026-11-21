# Task 3 fix report

## Scope and review-citation correction

This fix round stays within the approved task boundary: `functions/_lib/ai.js`, `functions/_lib/chat-app.js`, `shared/ai/chat-stream.js`, and the three unit test files.

Important correction to the review record: the cited deadline test in `chat-api.test.mjs:356-394` is not the actual misbehavior. The misleading test is the one at `chat-api.test.mjs:261-299`. It destructures a nonexistent `signal` from the injected `answerChat` argument and throws when `signal.aborted` is checked; that branch can misclassify an already-aborted timeout. The fix does not "repair" a fictitious test or add a fake `signal` property to `answerChat`. Instead, coverage is kept at the actual signal seam via `createAiService(env, signal)` / `AiService` and the real `AbortSignal` behavior.

## Changed files

- `functions/_lib/ai.js`
    - passes the same optional abort signal through `normalizeChatStream(...)`
    - preserves the original thrown error when the supplied signal is aborted, before logging or wrapping as `AppError`

- `functions/_lib/chat-app.js`
    - keeps `requestSignal` and `deadlineSignal` distinct
    - silently returns for client disconnects without logging or emitting any SSE write
    - uses a deadline-only check based on the actual deadline signal identity before emitting the existing safe error envelope and final `[DONE]`

- `shared/ai/chat-stream.js`
    - cancels the upstream `reader` on abort so pending reads terminate cleanly
    - suppresses provider-failure logging/writes for disconnect aborts while still preserving a real provider failure path
    - terminates the normalized output stream immediately after the final `[DONE]` so no second error frame is emitted after a terminal provider failure

- `tests/unit/ai-service.test.mjs`
    - verifies aborts remain the original error and no provider log occurs
    - adds a pending generation stream test that observes the shared abort signal

- `tests/unit/chat-api.test.mjs`
    - verifies disconnects produce no SSE output/logging
    - verifies deadline handling emits the existing safe error frame + `[DONE]` and no outage log
    - preserves the real provider-failure behavior check

- `tests/unit/chat-stream.test.mjs`
    - verifies pending read cancellation on abort
    - verifies deadline stream termination with the existing error envelope
    - preserves a real upstream provider-failure path with one error frame and one `[DONE]`

## RED/GREEN commands and exit codes

RED before fix, as required:

```bash
cd /home/samson/code/sg && node --test --test-timeout=30000 tests/unit/ai-service.test.mjs tests/unit/chat-api.test.mjs tests/unit/chat-stream.test.mjs
```

Exit code: 1

The red state showed the regressions described in the task: aborts were being wrapped/logged as service failures, disconnects still wrote SSE error frames, and pending normalizer reads did not observe cancellation.

GREEN after fix:

```bash
cd /home/samson/code/sg && node --test --test-timeout=30000 tests/unit/ai-service.test.mjs tests/unit/chat-api.test.mjs tests/unit/chat-stream.test.mjs
```

Exit code: 0

Offline acceptance per task brief:

```bash
cd /home/samson/code/sg && make lint format-check typecheck test ai-build
```

Exit code: 0

## Commit hash

- `ea601ff` — `fix: distinguish request cancellation from AI outages` (fix round 1)
- `30e6bbf93b4dd96778fb9715b7b212b11d56ffc4` — `fix: resolve stream-phase deadline handling` (fix round 2)

## Not independently verified

- No Cloudflare deployment, no production inference, no paid provider calls, and no live Worker mutations were performed; all validation stayed local/offline as required.
- The fix intentionally preserves the existing SSE contract and the request/deadline separation without broadening architecture or changing the API surface beyond the approved task.

## Fix round 2 (stream-phase deadline clause)

### What changed

- `shared/ai/chat-stream.js`
    - rechecks the abort signal immediately after a pending `reader.read()` resolves and before treating `{ done: true }` as a normal completion
    - preserves the deadline error path as a normalized output-stream failure so the outer route still emits the existing safe `{ error: ... }` frame and `[DONE]`
    - keeps request disconnects silent, without provider outage logging or a later SSE write
    - restores the explanatory comment around the `while (!emitted)` loop so the loop's purpose is clear
    - keeps the real provider-failure route as a single error frame + `[DONE]` with one console log and a single cancellation path

- `tests/unit/chat-stream.test.mjs`
    - adds the pending upstream-read regression: a never-erroring source that stays pending until the deadline aborts, then resolves as `{ done: true }` without an error; the output must still be the deadline-safe error frame and `[DONE]`, never success metrics
    - keeps the pre-aborted deadline path and the real provider-failure assertions in place

- `tests/unit/chat-api.test.mjs`
    - retains the actual deadline classification test at the true request/deadline seam; no fake `signal` property was added to `answerChat`
    - uses `t.mock.method` for test-context cleanup; explicit manual `AbortSignal.timeout` restoration remains and is redundant

### Validation

Commands run:

```bash
cd /home/samson/code/sg && node --test --test-timeout=30000 tests/unit/ai-service.test.mjs tests/unit/chat-api.test.mjs tests/unit/chat-stream.test.mjs
```

Exit status: 0

```bash
cd /home/samson/code/sg && make lint format-check typecheck test ai-build
```

Exit status: 0

### Evidence summary

- Focused task suite: 32 tests passed as reported for fix round 2. Fix round 1 reported 56 for the same command; Atuin history has no captured agent command output to reconcile the count difference.
- Offline acceptance: passed
- Remaining unverified behavior: no Cloudflare deployment, production Worker invocation, or live provider traffic; only offline mocks were used as required.
