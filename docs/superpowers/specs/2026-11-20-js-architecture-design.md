# JavaScript Architecture and Reliability Design

## Intent

Re-evaluate the first-party JavaScript as one system and fix the eight audit items selected by the user: vector cleanup namespace checks, ambiguous domain-cutover results, malformed retrieval-cache payloads, Mermaid retry behavior, cancellation reporting, chat-widget template/test drift, CRLF Wrangler parsing, and the evaluation summarizer's entry-point guard. The design should reflect a clean rebuild, but avoid rewriting code that already has a clear boundary and tested behavior merely to make the diff larger.

The repository is not one MVC application. Use the architecture that fits each runtime: feature modules and an MVC-inspired chat model/view/controller in the browser; an HTTP adapter and request-level service in the Worker; runtime-neutral AI/retrieval logic shared by the Worker, scripts, and evaluation; and thin CLI entrypoints around script workflows.

## Goals

- Make runtime-neutral AI, prompt, retrieval, stream, metric, and answer-policy code importable without depending on the Worker directory.
- Preserve existing browser and Worker composition roots and the site feature host.
- Make cloud mutation failures state-aware and bound vector-cleanup risk to one delete batch, while stating that no local check is a distributed lock.
- Treat invalid cached data as a miss, distinguish cancellation/deadline from provider failure, and allow a failed diagram render to retry on the same node.
- Test the widget's real Hugo output against the roles its controller requires.
- Preserve CRLF/LF config style and make the evaluation CLI safe to import in any process invocation.
- Keep behavior, tests, documentation, and import direction aligned; add no dependencies.

## Non-goals and constraints

- Do not impose MVC across the Worker, scripts, or evaluation, add a framework, or build generic browser-service abstractions.
- Do not change the chat request shape, SSE event envelope/ordering, `[DONE]` termination, widget methods/events, corpus schema, corpus IDs/hashes/namespaces, or CLI flags/output unless a specific requirement below needs it. User permits contract changes, but none are presumed necessary beyond correcting timeout classification.
- CI token scope finding 3 is out of scope.
- Do not perform paid inference, deploy, or mutate/delete cloud resources. All verification must be offline and use injected clients or fixtures.
- Follow project commands through Make; retain JSDoc typechecking, lint, formatting, and offline test conventions.

## Target boundaries

### Browser

Keep `assets/js/site.js` and `assets/js/menu-a11y.js` as composition roots using the existing feature host. Keep `assets/js/ai-chat-widget.js` as the chat custom-element controller, `assets/js/chat/model/` as conversation/stream state, and `assets/js/chat/view/` as DOM rendering. Inject browser capabilities only where needed for an actual lifecycle or deterministic test seam. Leave the theme-loaded classic `background-blur.js` standalone and do not merge the theme Mermaid facade with the chat's lazy ESM loader.

### Runtime-neutral AI core

Create `shared/ai/` as the dependency root for logic consumed by more than one runtime. Move portable configuration/model helpers, prompts, retrieval, provider-stream normalization, response metrics, and the no-context answer policy there. Keep `ChatRequestSchema` and HTTP-only validation in `functions/_lib/validation.js`; keep `AppError` and Vectorize-binding checks in a Worker-only module under `functions/_lib/`. The shared code must not import Hono, Cloudflare bindings/SDK, Node-only APIs, or modules under `functions/`, `scripts/`, or `assets/`.

`functions/worker.js` remains the Worker composition root. `functions/_lib/chat-app.js` owns HTTP concerns (CORS, request limits/schema, rate limiting, deadlines, SSE response); `functions/_lib/ai.js` adapts Workers AI and Vectorize to the shared retrieval and model helpers. `scripts/lib/` owns Cloudflare SDK/REST adapters and corpus workflows. `evals/` uses the same shared retrieval/prompt/stream implementation as production. No compatibility re-export layer should hide the new import direction.

The shared files must be typechecked in both Worker and Node environments. Update only the necessary TypeScript includes, ESLint environment, formatter globs, and coverage inventory; do not create a new package or add a build system.

## Required behavior changes

1. **Vector cleanup:** Re-read the live and previous namespace before each `deleteByIDs` request (20 IDs). Stop before submitting the next batch if either changes. Update tests and README/comments to state the one-batch bound and that manual mutation must still be serialized because there is no distributed lock. Preserve dry-run and retention behavior.
2. **Domain cutover:** Treat a thrown remote mutation as an unknown outcome, not proof it failed. After a Pages detach or Worker attach error, inspect Pages and Worker domain state using the installed SDK. If the hostname is still on Pages, stop with the original error. If it is attached to the intended Worker, regard it as moved. If it is unattached, restore Pages. If state cannot be read or an unexpected Worker owns it, stop with actionable manual-recovery details and retain both causes. Never blindly retry a mutation based only on a timeout. Test errors that occur before and after each mutation takes effect, plus reconciliation/read failure.
3. **Retrieval cache:** A hit is usable only when `contextText` is a string and `evidence` is an array; otherwise fall through to normal retrieval and overwrite the bad entry when normal cache conditions permit. Malformed JSON and cache I/O keep existing fail-open behavior.
4. **Diagram retries:** On Mermaid load/render failure, permit the same code node to be attempted on the next panel open. Keep one failure note per source block, and replace/remove it on successful rendering.
5. **Cancellation:** Propagate abort state through model calls and stream reading. A visitor disconnect must stop paid work without logging or writing another SSE event. A request deadline must terminate the SSE stream with the existing error-event shape and `[DONE]`, but must not be reported/logged as a provider outage. Real provider failures retain current error handling. Cover cancellation during rewrite, embedding, generation startup, and stream consumption.
6. **Widget roles:** Add an integration assertion against Hugo-rendered widget markup that all roles required by `ai-chat-widget.js` exist exactly as expected; avoid a second hand-maintained test-only role list.
7. **Wrangler line endings:** Recognize `[vars]` with LF or CRLF and preserve the input's newline convention when inserting settings. Do not normalize/rewrite unrelated configuration.
8. **Evaluation CLI:** Use `scripts/lib/cli.mjs::runIfMain` for the summarizer with a promise-returning `main`, retaining the exported synchronous `summarize()` helper and existing command output.

## Contracts and safety invariants

- The browser widget's methods and events, required DOM roles, chat API input, SSE schema/order/terminal marker, and current CLI arguments remain stable.
- Retrieval still uses one implementation in production and evaluation. Corpus hashes, chunking, IDs, retained namespaces, readiness checks, and mutation safeguards are untouched.
- A cache defect cannot turn a recoverable retrieval into a failed chat turn.
- Disconnected requests do not continue paid model work or attempt to write to a closed response. A deadline still ends with a terminal SSE event.
- Cleanup checks namespace state before each batch, but operators must continue to keep manual namespace writers outside the serialized refresh/deploy/cleanup window.
- Domain compensation is based on observed remote state; if state is ambiguous, the script fails closed and gives a recovery action rather than guessing.

## Evidence and acceptance

- Add one focused regression test per behavior before changing its production implementation, and verify each new test fails for the intended reason.
- Use installed Cloudflare SDK types and injected/mock-fetch or fake-client tests; do not call production Cloudflare APIs.
- Build Hugo fixture output for the widget-role contract. Test same-node Mermaid failure then retry. Test CRLF output bytes and import of the summarizer when `process.argv[1]` is absent.
- Verify module portability by importing the shared core from both the Worker and Node/script dependency graphs and typechecking both environments.
- After focused suites, run `make lint`, `make format-check`, `make typecheck`, `make test`, `make test-layouts`, `make ai-build`, and `make ci-check` once on the reconciled tree. No paid flow or deployment is part of acceptance.

## Implementation discretion

The builder may choose exact filenames within `shared/ai/`, error wording for the deadline, and test fixture helpers, provided the boundaries, contracts, safety limits, and acceptance evidence above are met. If an SDK limitation prevents the specified state reconciliation, stop and report the limitation before implementing a weaker behavior.
