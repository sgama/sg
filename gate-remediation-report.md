# Gate remediation report

## Scope

This remediation addressed the final cross-cutting issues in the shared AI core / worker reliability fix without changing the public HTTP, SSE, corpus, CLI, or widget contracts.

### Changed files

- `AGENTS.md`: restored the shared model-settings guidance and retrieval design note.
- `eslint.config.js`: narrowed the shared prohibition to `shared/**/*.js`, added the exact shared runtime globals, and kept scripts/tests free to use Node/Hono/Cloudflare imports as normal.
- `scripts/deploy_needed.mjs`: kept the shared deploy input covered and verified it triggers a deploy when a shared-only change is present.
- `functions/_lib/chat-app.js`: preserved distinct `requestSignal` and `deadlineSignal` composition through the route and kept optional abort checks consistent.
- `functions/_lib/ai.js`: propagated the real deadline signal through `AiService` without widening the public API.
- `shared/ai/chat-stream.js`: consolidated deadline/abort termination, kept a single terminal `[DONE]`, and preserved silent client disconnects and the real deadline identity path.
- `tests/unit/deploy-needed.test.mjs`: added the shared-only deploy regression.
- `tests/unit/shared-ai.test.mjs`: added the forbidden-imports and narrow-globals regression.
- `tests/unit/chat-stream.test.mjs`: added deadline-identity and provider-terminal-order coverage.
- `tests/unit/chat-api.test.mjs`: preserved the deadline-vs-client-abort regression coverage for the route layer.

## RED / GREEN evidence

### RED

- Initial `make lint` failed with exit code 2 because `no-restricted-imports` was applied globally instead of only to `shared/**/*.js`, and the shared globals omitted `crypto` and `queueMicrotask`.
- The deadline identity and shared deploy regressions were addressed by targeted failing tests before the fix, then verified after the final implementation.

### GREEN

- `make lint` passed after scoping the restriction and restoring the required shared runtime globals.
- `make format-check`, `make typecheck`, `make test`, `make test-layouts`, `make ai-build`, and `make ci-check` all passed on the reconciled tree.

## Acceptance commands and results

- `make lint` — exit 0
- `make format-check` — exit 0
- `make typecheck` — exit 0
- `make test` — exit 0
- `make test-layouts` — exit 0
- `make ai-build` — exit 0
- `make ci-check` — exit 0

## Commit and report notes

- Scope kept to the brief: shared-only deploy detection, shared import boundary, deadline identity, stream termination, and the final acceptance/report gate.
- No paid inference, no Cloudflare API mutations, no deploy/push operations, and no public contract changes were performed.
- Final commit hash: pending until the reconciled commit is created.
- The tracked SDD report files were removed from the git index only (`task-1-report.md` and `task-3-fix-report.md`), while their local ignored copies were retained.
