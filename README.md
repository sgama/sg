# samsongama.com

[![Actions Status](https://img.shields.io/github/actions/workflow/status/sgama/sg/main.yml?branch=develop&label=actions)](https://github.com/sgama/sg/actions/workflows/main.yml?query=branch%3Adevelop)
[![Build Status](https://img.shields.io/github/actions/workflow/status/sgama/sg/main.yml?branch=develop&label=build)](https://github.com/sgama/sg/actions/workflows/main.yml?query=branch%3Adevelop)
[![Last Commit](https://img.shields.io/github/last-commit/sgama/sg/develop)](https://github.com/sgama/sg/commits/develop)
[![Repo Size](https://img.shields.io/github/repo-size/sgama/sg)](https://github.com/sgama/sg)
[![Open Issues](https://img.shields.io/github/issues/sgama/sg)](https://github.com/sgama/sg/issues)
[![Stars](https://img.shields.io/github/stars/sgama/sg)](https://github.com/sgama/sg/stargazers)
[![Forks](https://img.shields.io/github/forks/sgama/sg)](https://github.com/sgama/sg/network/members)
[![Commit Activity](https://img.shields.io/github/commit-activity/m/sgama/sg?branch=develop)](https://github.com/sgama/sg/graphs/commit-activity)
[![License](https://img.shields.io/github/license/sgama/sg)](LICENSE)

A modern, responsive personal website built with [Hugo](https://gohugo.io/) and the [Blowfish](https://blowfish.page/) theme. This repository contains the source code for my personal website featuring blog posts, portfolio projects, and resume.

## 🚀 Quick Start

### Prerequisites

- [Hugo](https://gohugo.io/installation/) (Extended version recommended)
- [Go](https://golang.org/doc/install) matching the version declared in `go.mod`
- [Git](https://git-scm.com/)
- Node.js 22+ for Wrangler and the local AI infrastructure tools
- [Pre-commit](https://pre-commit.com/) (optional but recommended)

### AI Assistant Setup

To enable the AI chatbot feature:

1. **Install dependencies**:

   ```bash
   npm install
   ```

2. **Create Vector Database** (One-time setup):

   ```bash
   npx wrangler vectorize create portfolio-index --dimensions=768 --metric=cosine
   ```

3. **Validate and plan the corpus** (offline):

   ```bash
   npm ci
   make ai-check ai-plan
   ```

4. **Ingest a candidate**, using the namespace printed by the plan:

   ```bash
   export CLOUDFLARE_ACCOUNT_ID="your_id"
   export CLOUDFLARE_API_TOKEN="your_token"
   make ai-embeddings AI_NAMESPACE=corpus-HASH_FROM_PLAN
   ```

   This makes paid Cloudflare API calls. It does not activate or delete a corpus.
   Follow the evaluation and release procedure below before changing production.

### Chat Widget Architecture

Model-facing retrieval headers include titles and public URLs, not repository
filenames. Internal context may cite public pages through its Markdown source
links. The answer prompt requests readable linked citations and prohibits
internal corpus paths or concatenated URLs in reader-facing answers.
Answers should lead with the fact rather than retrieval boilerplate, with citations
beside the claim and labels matching the public destination (for example, Resume
or About), not the title of an internal excerpt.

[`assets/js/ai-chat-widget.js`](assets/js/ai-chat-widget.js) registers
`<ai-chat-widget>` and coordinates the dialog, messages and request lifecycle.
Independent history, stream, scroll and message-rendering modules live in
[`assets/js/chat/`](assets/js/chat/); Hugo bundles the local modules into one
widget script. [`layouts/partials/extend-footer.html`](layouts/partials/extend-footer.html)
supplies the light-DOM template and loads fingerprinted scripts.
[`assets/css/site.css`](assets/css/site.css) supplies widget-scoped styles, and
[`postcss.config.js`](postcss.config.js) preserves dynamically generated message
classes during production CSS purging.

The widget uses light DOM, not Shadow DOM. Settings are script constants, not
custom-element attributes. Its native dialog opens with non-modal `show()` and
does not trap Tab focus. There are no touch gestures or attribute-change handlers.
Theme-neutral surfaces follow the site's `.dark` or root
`data-theme="dark"` state; blue accents mark actions and user messages. Controls
have visible focus outlines. The launcher has continuous signal rings, disabled
for reduced-motion preferences and while the chat is open.

The message renderer loads Markdown dependencies lazily, sanitizes generated
HTML before insertion, and keeps user messages as plain text. Failed dependency
loads log a warning and retain plain-text rendering; reconnecting retries them.
Stream cleanup releases reader locks and preserves the original request error
if cancellation also fails.

#### Integration and lifecycle

The public methods are `open()`, `close()`, `toggle()` and
`setPendingQuestion(text)`, with bubbling `chat-open` and `chat-close` events.
[`assets/js/site.js`](assets/js/site.js) wires `.js-chat-trigger` elements and
their optional `data-question`, randomizes suggestion chips, and integrates
accessibility-panel settings.

Connection clones the template once and installs abortable event listeners.
History reads, transcript rendering, resize observation and Markdown loading
begin on first open, or immediately for a restored open session. Reopening reuses
the conversation; reconnecting resets the lifecycle without duplicating messages
or handlers. Disconnection cancels requests, listeners and pending frames.

Opening shows the latest message after layout. Sending resumes scroll following;
reading older messages pauses it and reveals a "Latest messages" button.
ResizeObserver handles delayed content and viewport layout without polling.
Escape closes the dialog and restores opener focus; streaming does not move focus.
Enter sends, Shift+Enter adds a newline, and IME composition does not submit.
The composer stays editable during generation; duplicate submissions are blocked.

#### Streaming, storage and accessibility

The browser posts `{ query, history }` to `/api/chat`, selecting at most the four
most recent user/assistant messages within the API's character limits; the
welcome message is omitted. This bounded request history is sent for conversational
context, while the full saved transcript remains local. Before vector retrieval,
the backend uses the configured contextualization model to rewrite follow-ups
into standalone queries. Rewriting is skipped when there is no history.
Normalized SSE carries `data: {"response":"..."}`, optional usage, and `[DONE]`;
reasoning is omitted. Rendering is throttled with animation frames. Empty,
malformed, interrupted and explicitly failed streams show errors rather than
silently succeeding.

Closing, stopping, clearing history or disconnecting aborts the browser request.
Partial answers retain a stopped/error notice. Request-identity guards prevent
older streams from overwriting newer conversations. Completed/stopped messages
are persisted synchronously, so delayed writes cannot restore cleared history.
Marked and DOMPurify load on demand for sanitized Markdown; loading failures
fall back to plain text.

History uses localStorage and open state uses sessionStorage, with guarded access
when storage is unavailable. The template has labeled controls, a 500-character
textarea, a transcript with `role="log"` and polite announcements, `aria-busy`
during generation, and a separate request-status region. The launcher exposes
expanded state and references the dialog.

#### Widget validation

Run `make ai-test` and `make ai-build` for unit tests and Functions compilation.
Before a UI release, manually check buttons/external triggers/Escape, Enter and
Shift+Enter, streaming/errors/cancellation/offline behavior, saved and cleared
history, Markdown sanitization/text fallback, focus, mobile layout and
screen-reader announcements. Unit DOM fixtures do not replace real-browser,
assistive-technology or virtual-keyboard testing; this is not an accessibility
certification.

### AI Infrastructure and Model Evaluation

AI configuration is shared by the runtime and evaluation tools in
[`functions/_lib/application.js`](functions/_lib/application.js). Model aliases are
`glm`, `gemma`, and `llama`; each registry entry defines its model ID, generation
parameters, completion-limit field, and dated token prices. Add an entry there to
compare another Workers AI model without duplicating pipeline code. Model access
and pricing must be verified against your Cloudflare account.

```bash
# Offline checks: no credentials, inference calls, or Hugo needed
make ai-models
make ai-check ai-test ai-plan
make ai-build
node scripts/ai-eval.mjs compare --models glm,gemma --repeats 3 --dry-run

# Paid: compare generation using identical labeled-source contexts
make ai-compare AI_MODELS=glm,gemma,llama AI_REPEATS=3

# Paid: evaluate a previously ingested candidate and then reuse its contexts
make ai-retrieval-eval AI_NAMESPACE=corpus-HASH_FROM_PLAN
make ai-compare-rag AI_NAMESPACE=corpus-HASH_FROM_PLAN AI_MODELS=glm,gemma AI_REPEATS=3
```

Reports are written to ignored `reports/` files. Override `REPORT_DIR`,
`AI_FIXTURE`, `AI_TIMEOUT_MS`, `AI_RETRIEVAL_REPORT`, or `AI_COMPARISON_REPORT` as
needed. Comparisons are serial and interleaved by case/model, with 1-20 repeats,
no automatic retries, and an explicit per-inference timeout. This bounds cost
and prevents accidental load tests. Developers run these Make targets locally
and review the reports before changing models or retrieval settings. Model
evaluation and quality-release validation are not GitHub Actions jobs. Production
CI prepares the corpus on each production push, skipping ingestion when its
namespace matches the active deployment.

The labeled fixture in [`tests/fixtures/ai-eval.json`](tests/fixtures/ai-eval.json)
checks expected source paths rather than keyword-only retrieval hits. Its answer
checks are deterministic term assertions, not a substitute for human groundedness
review. Extend the small starter set with paraphrases, project-specific facts,
negative questions, and production failures before trusting a model ranking.
Follow-up cases include bounded recent chat history. When history is present,
the API passes it as JSON data to a dedicated rewrite task before embedding,
rather than asking the model to continue the conversation. Retrieval reports record that query
and score labeled rewrite terms, source hits, and evidence separately. Add
conversation histories to the fixture to cover pronouns, elliptical follow-ups,
topic changes, and ambiguity.

Negative questions run through real retrieval in retrieved-context comparisons,
including irrelevant matches; they are not assigned an artificial empty context.
Source hit@k is computed only for questions with labeled relevant sources.
All cases, including negatives, must have successful retrieval records.
Version-2 reports are required; regenerate older positive-only retrieval reports.
Labeled-source comparisons still use oracle context and cannot establish
end-to-end abstention performance. Empty-context fallback is tested separately.

### Source formatting

`make format` applies Prettier to maintained JavaScript in assets, Functions,
scripts, tests and root JavaScript configuration files, plus source CSS under
`assets/css/` and YAML in the root, `data/` and `.github/`. `make format-check`
checks the same files without modifying them. Conventions are four-space
indentation, single quotes where practical, semicolons, trailing commas, LF
line endings and a 150-column wrapping preference. YAML uses two spaces and
a 120-column wrapping preference, matching the existing yamllint configuration.

Formatting is separate from ESLint correctness checks (`make lint`). Hugo
templates, Markdown content, TOML and generated output are outside this
formatting pass, including `assets/css/site.purged.css`. YAML linting and
TOML tooling remain unchanged; CSS formatting does not add CSS linting.
No CI or pre-commit formatting gate is added by this rollout.

### Chat model details and response metrics

Responses expose a collapsible **Retrieved sources** panel with only public-page
excerpts actually included in the bounded model context. Internal RAG excerpts
are omitted. These are retrieval evidence, not independently verified citations.
Source links and literal excerpt text persist locally with the answer.
The streaming API reports real rewrite, embedding, search and generation stages;
the widget displays these while waiting for answer tokens. Failures after SSE
starts are explicit error events (HTTP status is already 200); validation and
missing-binding errors still return HTTP error responses before streaming.
No feedback collection is implemented.
Empty conversations offer four starter shortcuts. Retrieved excerpts use the
same sanitized Markdown renderer as answers, with plain-text fallback when
renderer modules are unavailable. Waiting states show elapsed client time until
the first answer token. Failed requests offer a manual Retry action using the
original question and pre-request history; paid requests are never retried
automatically. Timers stop on completion, failure, cancellation, or disconnect.

Chat history persists across deployments until the visitor clears it.

The chat header renders two compact model-information rows at Hugo build time.
[`data/chat_ai.json`](data/chat_ai.json) is the shared model/configuration and
dated pricing source for Hugo, the API and evaluations; the answer model is
selected from `AI_MODEL` in [`wrangler.toml`](wrangler.toml).
Completed responses include server-side total/time-to-first-answer-token,
embedding/search/rewrite timings, reported answer and rewrite token counts, and
estimated LLM token cost. Cost excludes embeddings, Vectorize and hosting and
is unavailable when required usage is missing, rather than reported as zero.
Metrics persist with local chat history but are never sent as conversation
evidence. Historical messages without metrics remain readable.
The non-selectable response footer includes an accuracy warning encouraging
readers to verify important details against the original sources.
The footer shows a compact total/first-token latency and estimated-cost summary,
with a keyboard-accessible Details disclosure for timing and token-count tables.

### Authoring employer-facing RAG context

[`content/_context/`](content/_context/) holds headless Markdown: indexed for
chat responses but not rendered as website pages. Its focused documents cover
career overview, skills, employer-specific contributions, early career,
reliability practice, leadership, projects, education/security, hiring logistics
and athletics. The career excerpts are sourced from the canonical
[`content/resume/_index.md`](content/resume/_index.md) and the about page.
Ingestion splits every included source at level-one/two Markdown headings,
retaining nested subsections together. Sections larger than a retrieval chunk
also get addressable parent records, bounded to 6,000 characters; oversized
sections are split into overlapping windows. Short sections remain single chunks.
Runtime and cloud evaluation expand semantic hits into their parent sections by
namespace-specific ID. Local evaluation uses the same expansion. Sibling hits
are deduplicated in search order within the existing 12,000-character context
budget. This applies equally to resumes, projects, posts, and internal context;
there is no topic-specific lookup or generated career summary.
A missing referenced parent is an explicit retrieval error. Existing corpora
without parent metadata retain semantic-only retrieval; reindex the updated
corpus to enable expansion. Expansion improves evidence coverage around a hit,
but cannot recover a source that semantic search never matches.
Keep these excerpts synchronized when the resume changes; they are curated
retrieval material, not an independent record of qualifications.

Each document includes `<!-- FILL IN: ... -->` authoring comments describing
useful missing interview evidence. The corpus builder strips HTML comments
from internal context before chunking; comment-only files are treated as empty,
and unclosed comments fail validation. Replace comments with confirmed,
public-safe prose when ready. Never leave placeholder facts or guessed
metrics in ordinary Markdown: they would be indexed as evidence.

Keep each topic self-contained: name the employer/project, your contribution,
relevant tools, dates, measured result and source. Short factual sections are
more useful to retrieval than a document that merely says to consult the resume.
Add a dated situation/action/result story for incidents, trade-offs and
collaboration. Preserve the distinction between individual and team ownership,
production and lab experience, preferences and demonstrated capabilities.

**Headless does not mean confidential.** Indexed prose can be disclosed in
public chat, files in a public repository are accessible, and transcripts are
currently public. Even excluded authoring comments remain visible in the
repository. Do not commit secrets, private customer details, references'
contact information or sensitive hiring documents.

After edits, run `make ai-check ai-plan` for offline corpus/fixture validation.
Use the local GPU targets for separate model experiments if desired. Production
CI indexes the changed corpus on deployment; editing these files alone does not
update the live index. Old benchmark reports are not evidence for the new corpus.

#### Offline RAG audit

Run `make audit-rag` to write a private, ignored `reports/rag-audit.json`.
It needs installed Node dependencies but no credentials, Docker, inference or
automatic dependency installation.

[`data/rag_audit.json`](data/rag_audit.json) maps the UI questions in
[`data/prompts.yml`](data/prompts.yml) to context documents and required evidence
groups, and records canonical source SHA-256 fingerprints and a review date.
The audit checks whether approved corpus text contains every evidence group,
not whether semantic retrieval will find it. It reports documented, partial
and unmapped questions and counts remaining `FILL IN` authoring comments.
Sources changed since review, missing document provenance, unfinished sections
and reviews older than 90 days produce warnings. Broken source paths, invalid
hash/date metadata, missing mapped documents and malformed configuration fail.

After changing a canonical source, review the dependent excerpts before updating
its fingerprint and the review date. Compute a fingerprint with
`sha256sum content/resume/_index.md` (or the relevant source). Never refresh
fingerprints automatically just to suppress warnings. Update question mappings
when changing UI prompts. The current mappings cover factual introductory
answers; authoring warnings still identify missing deeper interview stories.

Retrieval fixture cases now define `evidenceTerms`: each group needs at least
one matching term in the actual bounded context supplied to generation.
Source-header metadata is excluded from this evidence check. Source `hitRate`
and `evidenceRate` are reported separately; both must meet `AI_MIN_HIT_RATE`
in cloud and local quality validation. Salary remains an unlabeled negative
case and is excluded from both retrieval-rate denominators.
Release validation recomputes evidence from report contexts rather than trusting
a claimed score. Curated internal excerpts are accepted as relevant sources
alongside the canonical resume where appropriate.

These are deterministic regression assertions, not semantic proof, exhaustive
coverage or factual-accuracy scores. Regenerate retrieval/comparison reports:
the changed fixture hash invalidates earlier reports. Historical benchmark
numbers below used the earlier fixture and must not be compared as identical
tests. Evidence assertions and the audit do not publish or re-index content.

### Local Docker/GPU validation

For fully local RAG validation on an NVIDIA GPU:

```bash
make ai-local-check       # Offline settings/corpus/fixture validation
make ai-local-validate    # Download/cache models, evaluate on GPU, tear down and exit
make ai-local-hybrid      # Local BGE retrieval + paid Cloudflare GLM generation
make ai-local-clean       # Explicitly delete the owned model-cache volume

# Override model, repetitions, cache or report destination
make ai-local-validate AI_REPEATS=3 AI_LOCAL_CONTEXT=4096 \
  AI_LOCAL_VOLUME=sg-ollama-models AI_LOCAL_REPORT=reports/ai-local-glm.json
```

Requires Docker Compose v2, NVIDIA Container Toolkit configured for Docker,
Node dependencies (`make deps`) and curl. Embeddings now default to the production
model family, `BAAI/bge-base-en-v1.5` (768 dimensions), served by Hugging Face
Text Embeddings Inference (TEI) with its CUDA image and float32 weights.
Local generation defaults to
`hf.co/unsloth/GLM-4.7-Flash-GGUF:GLM-4.7-Flash-UD-IQ3_XXS.gguf`
through Ollama with thinking disabled. This is a community quantization of the
deployed GLM-4.7-Flash model family, not the same precision or serving engine.
The GGUF download is 12,907,368,800 bytes (about 12.0 GiB); runtime buffers and
KV cache need additional VRAM. `AI_LOCAL_CONTEXT=4096` bounds context memory
for the 16 GB RTX 4080, but full GPU residency is not guaranteed. The GPU check
requires some GPU residency, not all layers; partial CPU offload can slow runs.
Override `AI_LOCAL_MODEL` to choose another model or quantization.
Override `AI_LOCAL_EMBED_IMAGE` to pin TEI (default
`ghcr.io/huggingface/text-embeddings-inference:cuda-1.9`).
Override `AI_LOCAL_IMAGE` to pin an
Ollama version or image digest; the default is `ollama/ollama:latest`, and the
resolved image ID and loaded model digests are recorded in the local report.
First use downloads several GB; subsequent runs reuse the named model cache.
Ollama's local API is bound only to loopback on a dynamically assigned port.
The default local mode makes no Cloudflare calls. `make ai-local-hybrid` uses
local retrieval followed by paid Cloudflare generation, defaulting to the
shared `glm` model registry entry. Override `AI_LOCAL_CLOUD_MODEL` for another
registered model. Credentials remain on the host and are not passed into either
container. Neither mode changes cloud indexes or deployments.

[`docker-compose.yml`](docker-compose.yml) defines GPU reservations and an
external named volume (`sg-ollama-models` by default). Each invocation gets its
own Compose project and network. The TEI embedding container runs first and is
stopped before the Ollama generation container starts; GPU inference does not
overlap. Hybrid mode never starts Ollama. Exit, validation failure, Ctrl-C and
termination trigger teardown without deleting the model cache. SIGKILL or host
failure cannot run cleanup: the printed project name can be recovered with
`docker compose -f docker-compose.yml -p PROJECT_NAME down --remove-orphans`.
Cache cleanup checks the ownership label and uses non-forced volume deletion;
Docker refuses removal while any container still uses it. Existing unowned
volumes are rejected rather than adopted or deleted. Never use a shared
production volume as `AI_LOCAL_VOLUME`.

The evaluator embeds the current corpus locally in batches, uses exact in-memory
cosine search (no database container needed for this small corpus), and reuses
the existing retrieval fixture, source headers, prompt, answer checks and timing
logic. BGE receives unprefixed text, matching the production request payload;
vectors are normalized for cosine search. TEI truncates inputs to its model's
512-token limit; this is recorded explicitly in local report preprocessing.
The production character-based chunks can exceed that token limit.
Matching model weights does not guarantee
identical provider preprocessing or numerical results. Override
`AI_LOCAL_EMBED_MODEL` and its matching `AI_LOCAL_DIMENSIONS` together.
TEI uses the explicit CUDA image and NVIDIA device reservation, and its reported
model identity is checked. Ollama generation GPU residency is checked explicitly.
Local generation is serial with temperature 0, 512 completion tokens, and
`AI_LOCAL_TIMEOUT_MS=120000` per API request. Model downloads and initial
indexing are outside answer latency measurements.
Generation model loading is included in the first answer's latency; p95 over
13 samples includes that cold start. Use repetitions to inspect warm samples
separately rather than interpreting the aggregate p95 as steady-state latency.

`reports/ai-local.json` is private and ignored, with local model/corpus provenance
and retrieval/comparison results. The command exits nonzero on transport/GPU
errors, hit rate below `AI_MIN_HIT_RATE`, answer-check rate below
`AI_MIN_ANSWER_RATE`, or any required regression failure. Threshold overrides
can make a diagnostic run less restrictive but do not disable required checks.
Cloud pricing is absent for local generation; hybrid mode estimates generation
cost from the shared registry. Local hardware/electricity costs are not measured.
Exact search differs from Vectorize, and quantized local GLM can differ from deployed GLM,
so **local reports cannot satisfy the Cloudflare release gate** or establish
Cloudflare latency, cost, or factual accuracy.

The initial Nomic/Qwen run (before switching embeddings to BGE) on 2026-10-07
verified GPU residency for both models
(approximately 0.60 GB embedding / 5.98 GB generation VRAM reported by Ollama),
completed all 13 generation requests and removed its container and network.
It failed quality validation: source hit@3 was 5/12 (41.7%) and answer checks
were 3/13 (23.1%). First-answer p50 was 217 ms; the 25.2-second p95 included
the first model load. Retrieval often missed the resume entirely, so this run
does not isolate generation quality. Token usage was present for 13/13 answers;
the initial summary incorrectly reported zero usage coverage because local
models have no cloud token price. Usage coverage now counts valid token usage
independently of pricing; estimated dollar cost remains unavailable.

The subsequent BGE/Qwen staged run on the same date completed 13/13 generations,
with source hit@3 of 8/12 (66.7%) and answer checks of 4/13 (30.8%).
Both services and the network were removed afterward; the embedding service
was stopped before generation started. This is still below validation thresholds
and is not a measurement of deployed GLM generation.

### Measured GLM baseline

On 2026-10-07, a developer-run baseline used the current production corpus,
13 fixture queries and one GLM repetition. All contexts came from live
Vectorize retrieval, including the salary question. No visitor transcripts,
index mutations, deployments or local browser checks were used.

| Metric | Result |
| --- | --- |
| Successful retrieval queries | 13/13 |
| Labeled source hit@3 | 10/12 (83.3%; salary question excluded) |
| Retrieval latency p50 / p95 | 143 / 384 ms |
| Successful generation requests | 13/13; no empty-context abstentions |
| Deterministic answer checks | 5/13 (38.5%) |
| Required regression checks | 1/7 (14.3%) |
| First visible answer p50 / p95 | 343 / 537 ms |
| Generation completion p50 / p95 | 1,665 / 4,846 ms |
| Reported prompt / completion tokens | 16,388 / 1,240 |
| Estimated generation-only cost | $0.001487474; usage available for 13/13 |

The baseline **does not pass the release gate**. Retrieval was below the default
90% threshold; generation continued with `AI_MIN_HIT_RATE=0` for this diagnostic
invocation only. The default release thresholds remain unchanged. The generation
estimate uses registry prices dated 2026-10-07, not a billing measurement, and
excludes embeddings, storage, failed-call charges and plan allowances. Timings
are from a developer machine to the provider, not browser-visible or combined
end-to-end RAG latency. One repetition does not establish a model ranking.

Answer/source spot checks identified distinct problems:

- `analytics` missed the labeled analytics article and omitted Umami, although
  another retrieved article mentioned it alongside Plausible.
- `languages` and `resume-demonware` counted as source hits but retrieved the
  resume's opening chunk, not its skills row or load-testing details. Source
  hit@3 therefore overstates answer-evidence coverage.
- The C++ answers and Bitcomplete answer failed citation checks, despite
  conveying the expected core facts. The Absolute answer gave the documented
  20x throughput and 90% resource reduction from the portfolio article, but
  failed the fixture's resume-citation requirement; no resume chunk was retrieved.
- The salary answer correctly said the excerpts did not specify salary, but
  failed the narrow substring check. Conversely, `resume-skill-ratings` passed
  while making an unsupported absence claim about Python. The canonical resume
  lists Python. Answer-check rate is **not factual accuracy**.
- `chat-architecture` passed while repeating itself and describing an older
  Llama configuration from the article rather than the deployed GLM model.

Run provenance:

```text
Retrieval timestamp: 2026-10-07T23:13:43.815Z
Generation timestamp: 2026-10-07T23:16:45.803Z
Model: @cf/zai-org/glm-4.7-flash
Settings: enable_thinking=false; max_completion_tokens=512; stream=true
Embedding: @cf/baai/bge-base-en-v1.5; 768 dimensions
Retrieval: topK=3; maxContextChars=12000; 2000-character chunks; overlap=200
Corpus: e4dbc5550c38e70f96a8f8abbf6fef6bf3d2090c114df7dd1a07166a4fb120fd
Fixture: e582828e797e23df475c3e79a61021cd3f10d3baef52003697ec000c21fdcbe8
Prompt: 8e0ef33898f2090f50605de29af561cfaa9a6d3748b5771316c12e8a69f84bcb
```

Raw reports remain in ignored, private `reports/` files:
`ai-retrieval-glm-baseline-2026-10-07-fixed.json` and
`ai-comparison-glm-baseline-2026-10-07.json`. An initial attempt failed all queries
because SDK 7's generated `ai.run` URL encoded model slashes. The shared embedding
helper now uses native SDK `post` with a literal model path and no retries;
offline transport tests assert the exact URL. That failed attempt is not included
in the quality or latency metrics above.

Before publishing a model ranking, add repeated comparisons and human claim-level
review. Unit tests use mocks and cannot measure model quality, production latency
or production cost. Never publish credentials or visitor transcripts as examples.

Reports include:

- Retrieval hit@k, source IDs/scores, embedding and search latency.
- Generation first-visible-answer latency (TTFT), p50/p95, completion latency,
  inter-chunk gaps, success rate, and answer-check rate.
- Provider token usage and estimated generation cost using dated registry prices.
  Missing usage is `null`, never a zero-cost inference. `costComplete` flags
  failed or unpriced runs. Embeddings, storage, plan allowances and failed-call
  charges are excluded.
- Completion tokens per generation second includes prefill/TTFT. SSE chunks are
  not tokens; the tooling does not claim per-token latency or decode throughput.

Labeled-source comparisons isolate generation quality; retrieved-context
comparisons reuse a fixed retrieval report for fairness. Their timing is
generation-only, not browser-visible end-to-end RAG latency. Abstentions are
reported separately and excluded from generation latency/cost samples. No GPU
utilization, VRAM, FLOPS, server batching or prefix-cache metrics are available
from this managed inference tooling.

#### Source-grounded factual accuracy

These checks test agreement with published source content, not whether answers
are favorable to the site owner. They do not independently verify resume claims.
The assistant should report documented facts neutrally, acknowledge unsupported
claims, and avoid inventing either qualifications or limitations. The evaluation
set includes factual questions, a misleading premise, unsupported proficiency
ratings, and unavailable salary information.

`content/resume/_index.md` is the canonical resume. Edit it rather than maintaining
separate skills lists or proficiency ratings. The normal corpus builder indexes
it with the rest of the website; there is no generated resume copy or separate
resume build step. Retrieved chunks include source-path, title, and URL headers in the generation
prompt. Source labels count toward the context budget. Retrieval
can miss a relevant section. The assistant must acknowledge insufficient evidence
rather than treat an omitted fact as confirmed or disproved.

Retrieved resume evidence takes precedence over conflicting older excerpts and
prior assistant messages. The internal source-reference document is not additional
evidence of qualifications.

Developer validation workflow:

```bash
make ai-check ai-test ai-plan
# Paid: ingest the namespace printed above, then evaluate it
make ai-embeddings AI_NAMESPACE=corpus-HASH_FROM_PLAN
make ai-retrieval-eval AI_NAMESPACE=corpus-HASH_FROM_PLAN
make ai-compare-rag AI_NAMESPACE=corpus-HASH_FROM_PLAN AI_MODELS=glm AI_REPEATS=3
```

Review the actual answers, including citations and negations, before deployment.
Resume regression cases marked `required` must pass every repetition in the local
release gate, regardless of the aggregate pass-rate threshold. The corpus namespace
changes when the resume changes, so reports from older corpora cannot pass that gate.
Term checks are smoke tests, not semantic proof: add real failing questions,
paraphrases, false premises, and contradictory-history tests as failures arise.

This reduces contradictions, but it cannot guarantee arbitrary generated answers.
For guarantees on a narrow fact such as a skills list, use a deterministic
structured-data response instead of generation. A semantic verifier would need
to buffer an entire answer before streaming to avoid exposing unchecked text.
No such verifier is currently implemented. Production content refresh remains
automatic; paid model quality evaluations remain developer-run.

#### Safe corpus release and rollback

Corpus namespaces are deterministic hashes of source contents and embedding/chunk
configuration. Chunk IDs incorporate full source paths and the namespace: two
`index.md` files cannot overwrite each other, and a candidate cannot mutate the
active version. Ingestion rejects duplicates, invalid vectors and partial
failures. Accepted Vectorize mutations are asynchronous: wait for visibility and
rerun retrieval evaluation if necessary before proceeding. Character-based
chunking remains approximate, not a guaranteed tokenizer limit.

1. Run offline checks and ingest the candidate namespace.
2. Run `ai-retrieval-eval` and `ai-compare-rag` against it.
3. Review answers and source labels, not only latency or cost.
4. Set `AI_CORPUS_NAMESPACE` and the chosen `AI_MODEL` in `[vars]` in
   `wrangler.toml`. The namespace must exactly match the plan and reports.
5. Run the ordered release command:

   ```bash
   make deploy-ai AI_NAMESPACE=corpus-HASH_FROM_PLAN
   ```

The release gate requires the current corpus/fixture, retrieval configuration,
prompt, generation settings, selected model and successful retrieved-context
comparison. Defaults require hit@k >= 90% and answer checks >= 80%; override
`AI_MIN_HIT_RATE` / `AI_MIN_ANSWER_RATE` only after reviewing the evaluation set.
No inference is performed during the offline gate.

### Automatic content updates in production CI

Every push to `develop` validates code and builds the production site before
`make ai-refresh` and deployment. Refresh builds the exact commit's corpus and
compares its namespace with the active deployment snapshot. Unchanged corpora
skip embeddings/uploads; changed corpora are ingested and each accepted mutation
must finish indexing. Both paths update `AI_CORPUS_NAMESPACE` in the runner's
Wrangler configuration. The subsequent Pages deployment includes that setting;
the runner does not commit the generated configuration back to Git.

The old deployment continues serving its corpus if ingestion, indexing, or
deployment fails. Production jobs are serialized. Mutation readiness has a
three-minute deadline per upload batch and fails explicitly rather than activating
an unready namespace. Another writer advancing the same index past the expected
mutation marker can cause a conservative timeout; avoid concurrent manual ingestion.

Model comparison and quality gates remain developer-run. Use `deploy-ai` for
locally reviewed model/retrieval changes, or mirror the content refresh flow:

```bash
make ai-refresh
make deploy-pages
```

#### Deployment and corpus retention

After deployment, CI runs `make cleanup-deployments`. Cleanup preserves the
project's active deployment and five previous successful production deployments
on `develop`, plus other-branch production and in-progress production deployments.
All preview deployments are deleted, including in-progress previews. A rollback
preserves the active deployment and its successful predecessors.

Cleanup reads each retained deployment's environment snapshot to preserve its
`AI_CORPUS_NAMESPACE`. It first deletes obsolete deployments, then deletes vectors
in every unreferenced `corpus-*` namespace, including undeployed evaluation
candidates. Unversioned/foreign namespaces are untouched. Vector deletion waits
for the accepted mutation to finish processing.

Cleanup uses Cloudflare SDK 7 native retries: at most two retries per request,
with a 30-second timeout per attempt. The SDK retries connection failures,
HTTP 408/409/429, and 5xx responses, honoring `Retry-After` headers (including
120 seconds). Without a retry header it uses its default exponential backoff;
the JSON body's `retry_after` field is not used. Exhausted retries still fail CI.
Retries repeat the failed request, not the whole cleanup plan; existing inventory
checks remain in place, but they do not run between native retry attempts.
Inventory rechecks use fresh deployment lists and fetch detailed environment
snapshots only for retained deployments; obsolete deployment details are not
fetched. Retained namespace snapshots are re-read before each deletion.
Corpus refresh and direct ingestion use the same maintenance retry/timeout
policy for Pages and Vectorize operations. Paid embedding requests explicitly
disable retries to avoid automatic repeat inference charges.

After an acknowledged deployment deletion, cleanup allows up to five inventory
checks, one second apart, for that deleted ID to disappear from the Pages list.
Vectors are not pruned while deleted deployments remain visible. New or missing
deployment IDs, active-deployment changes, and retained corpus namespace changes
still stop cleanup immediately. Errors distinguish unexpected inventory changes
from acknowledged deletions that remain listed; the cleanup plan is never
automatically replaced.
The first embedding failure aborts in-flight requests and prevents queued
inference from starting; already-started inference may still incur charges.
Mutation readiness has an end-to-end three-minute deadline across requests,
SDK retry backoff and polling sleeps. Requests and sleeps receive its abort
signal; readiness still fails on time if SDK backoff delays observing cancellation.

Preview-only versioned corpora are pruned after preview deletion; corpora also
referenced by retained production deployments remain protected. Aliased previews
use the SDK's `force` deletion option, enabled only for previews; it does not
bypass production retention checks. API rejection
of preview deletion fails cleanup before vector pruning. A final inventory check
detects deployments created during cleanup. Disable unwanted automatic preview
builds in Pages branch controls and avoid concurrent external deployments:
cleanup cannot prevent previews being created after its final check.

Preview the plan without deletion:

```bash
node scripts/cleanup_deployments.mjs --dry-run
```

The command needs Pages read/delete and Vectorize read/write permissions.
Missing deployment namespace metadata, incomplete inventories, and detected
deployment changes stop cleanup explicitly. Legacy deployments without a known
namespace must be resolved before vector pruning can proceed. This index must
be dedicated to this project: other projects' references are not discovered.

Keep manual deployments, rollback, and ingestion out of the serialized production
refresh/deploy/cleanup window. Inventory rechecks reduce races but do not provide
a distributed lock against external writers. Re-ingest a candidate if cleanup
prunes it before your developer evaluation or deployment.

`ai-refresh` compares the computed corpus namespace with the active production
deployment snapshot. Matching corpora skip paid embeddings and uploads; changed
corpora are ingested and indexing must succeed before local `wrangler.toml` is
updated. Both paths set the deployment namespace. Pages lookup failures stop
refresh; initial deployments or legacy snapshots without a namespace require ingestion.
Use `make ai-refresh AI_REFRESH_FLAGS=--force` (or the CLI's `--force`) to rebuild
a missing or damaged index explicitly. Force refresh bypasses the Pages lookup.
Refresh itself does not delete older namespaces; post-deploy cleanup prunes
unreferenced versioned vectors. The hash includes source files, embedding and
chunking settings, including draft/front-matter changes. Individual unchanged
chunk reuse is not implemented. Deleted content is absent from
the new active namespace. Retained rollback namespaces continue consuming storage.
Leaving `AI_CORPUS_NAMESPACE` unset is only a migration fallback for deployments
not using the refresh flow. Rollback to an existing deployment retains its pinned
namespace; a manual rollback deployment must restore the previous namespace/model
configuration and avoid running refresh against newer content.

Runtime retrieval outages return 503 instead of pretending no context was found.

### Operational protections and remaining limits

`/api/logs` is intentionally public for demonstration; authentication is currently
disabled. Anyone can read stored visitor questions and answers, including older
entries, without an admin secret. Do not submit sensitive information.
Transcript responses use `Cache-Control: no-store`, which is not access control
and does not prevent viewers from copying transcripts. Chat transcripts are
stored for 30 days when the KV logging binding is enabled. Restore authentication
before treating transcripts as private; access does not expire automatically.

The public chat endpoint's CORS policy is not authentication or abuse prevention.
Regex injection checks are narrow heuristics, not a security boundary. No
application-level rate limit, calibrated relevance cutoff, or runtime
embedding/generation deadline is currently implemented. Configure and verify
Cloudflare edge abuse controls separately; do not infer they exist from this
repository. The 20-character abstention check detects empty/short context, not
whether evidence supports a claim. Quality evaluation remains developer-run,
not an automatic production release gate.
Chat logs store transcripts in KV values with small versioned metadata and unique
keys; the logs API can still read legacy metadata-only entries.

### Local Development

1. **Clone the repository**

   ```bash
   git clone https://github.com/sgama/sg.git
   cd sg
   ```

2. **Install dependencies** (Blowfish is a Hugo module, not a submodule)

   ```bash
   npm ci
   hugo mod get
   ```

3. **Start the development server**

   ```bash
   make serve
   ```

   Normal builds and the development server preserve Hugo's shared module cache:
   they do not use `--gc` or `--ignoreCache`. Avoid cache cleanup while a Hugo
   server is running, since it can invalidate theme assets used by hot reload.
   If a theme asset disappears, stop the server, run `hugo mod graph` to restore
   the pinned modules, then restart with `make serve`.

4. **Visit your site**
   Open [http://localhost:1313](http://localhost:1313) in your browser

`make serve` runs Hugo only. Use `make dev-ai` to build the site and run Pages
Functions through Wrangler when testing `/api/chat`; Workers AI calls can incur
charges even during local development.

## 🛠️ Available Commands

Use the Makefile for common development tasks:

| Command | Description |
| ------- | ----------- |
| `make help` | Show all available commands |
| `make deps` | Install dependencies reproducibly with npm ci |
| `make serve` | Start Hugo development server |
| `make dev-ai` | Run the site with Pages Functions through Wrangler |
| `make build` | Build the site without the production CSS purge |
| `make build-prod` | Build production assets with PostCSS and PurgeCSS |
| `make test` | Run the Node.js unit tests |
| `make lint` | Lint browser, Functions, scripts, and test JavaScript |
| `make lint-fix` | Apply ESLint automatic fixes |
| `make lint-workflows` | Validate all GitHub Actions workflows with actionlint |
| `make coverage` | Run tests and write HTML/LCOV coverage reports |
| `make ci-check` | Run offline checks and build the production site and Functions (Node 22+) |
| `make audit-content` | Validate content front matter coverage |
| `make audit-urls` | Check links using markdown-link-check |
| `make audit-site` | Run content and link checks |
| `make clean` | Remove generated output within the repository's public build tree |
| `make deploy-pages` | Build production assets and deploy to Cloudflare Pages |
| `make deploy-built` | Deploy an existing validated production build without rebuilding |
| `make deploy-ai` | Validate and gate an AI corpus/model release before deployment |
| `make ai-refresh` | Rebuild and index the current corpus, then update Wrangler's namespace |
| `make pre-commit` | Run all pre-commit hooks manually |

Validation commands suppress recipe echo and stream tools' native output without
filtering warnings or errors. Tests use Node's `spec` reporter; use
`make test TEST_REPORTER=tap` for TAP output. JavaScript coverage includes unexecuted
source files; reports are written to ignored `coverage/`. CI runs lint and
coverage before paid embedding refresh. See [tests/README.md](tests/README.md)
for scope, Node requirements, and report formats.

Pull requests targeting `develop` run `make ci-check` without Cloudflare credentials
or paid API calls. Production pushes run the same checks before refreshing the
corpus, deploying the existing build, and pruning old deployments. Production
runs remain serialized without cancellation to protect corpus/deployment updates.
CI caches npm downloads (not `node_modules`) and scopes Hugo caches by version and
module dependencies. The actionlint binary is cached by its Makefile-pinned
version, runner OS, and architecture; cache hits skip Go setup and compilation.
Hugo's build cache is saved after successful offline validation, before paid
refresh or deployment. `make ci` remains a paid production workflow, not an offline
check; use `make ci-check` for local validation.

Install dependencies explicitly with `make deps` before checks; audits never
install packages or change the lockfile. `npm run build` delegates to
`make build-prod`, including production CSS, and `npm run dev` delegates to
`make dev-ai` (port 8788; override with `DEV_PORT`).

CI runs independent offline checks with
`make --jobs=2 --output-sync=target ci-check`. Make prerequisites preserve
PostCSS-before-Hugo ordering, while target output stays grouped. Corpus refresh,
deployment, and cleanup remain sequential. The paid `make ci` entry point also
bounds its validation phase to two jobs.

Build targets honor `PUBLIC_DIR`. Cleanup accepts only the repository's `public`
directory or descendants, rejects paths resolving outside that tree and tracked
files, and refuses an empty destination. Custom output elsewhere must be cleaned
explicitly. Stop foreground development servers with Ctrl+C; the force-kill
target has been removed.

Workflow linting uses native actionlint, silent on success with source-located
diagnostics on failure. CI installs the version pinned in the Makefile.
Install it locally with `make install-actionlint` (requires Go)
and add `$(go env GOPATH)/bin` to PATH, or pass
`ACTIONLINT=/path/to/actionlint` to Make. If ShellCheck is available, actionlint
also checks embedded shell scripts.

## 📁 Project Structure

```md
sg/
├── archetypes/          # Content templates
├── assets/              # Site assets (images, CSS, JS)
├── config.toml          # Hugo, theme, language and menu configuration
├── content/             # Markdown content files
│   ├── _context/        # Internal RAG corpus, not user-facing pages
│   ├── posts/           # Blog and project page bundles
│   ├── portfolio/       # Portfolio content
│   ├── about/           # About page
│   ├── contact/         # Contact page
│   └── resume/          # Resume page
├── functions/           # Cloudflare Pages Functions and shared AI helpers
├── scripts/             # Audits, ingestion and AI evaluation tooling
├── tests/               # Unit tests and labeled AI evaluation fixtures
├── layouts/             # Custom Hugo templates
│   ├── partials/       # Reusable template components
│   └── shortcodes/     # Custom Hugo shortcodes
├── public/              # Generated static site (git-ignored)
├── resources/           # Hugo processed resources
├── static/              # Static files (copied as-is)
├── go.mod              # Go module dependencies
├── Makefile            # Development commands
└── .pre-commit-config.yaml # Code quality configuration
```

## 🎨 Theme Configuration

This site uses the [Blowfish theme](https://blowfish.page/) with extensive customization:

### Key Features

- **Dark/Light mode** with Catppuccin color scheme
- **Hero background** layout with custom imagery
- **Card-based** post and project listings
- **Search functionality** enabled
- **Table of contents** for articles
- **Reading time** and word count
- **Social media links** integration

### Customization Files

- `config.toml` - Core Hugo settings, theme parameters, languages and menus
- `assets/css/site.css` - Custom CSS overrides (merged)

## ✅ Code Quality & CI/CD

This repository includes comprehensive code quality tools:

### Content Quality Gates

Checks for content health and link integrity are available via Makefile targets:

- **Content coverage:** Required front matter fields and recommended metadata coverage.
- **Link integrity:** Links checked with markdown-link-check.
- **Build health:** Production Hugo build/deployment in CI; `make ai-build` locally
  for standalone Pages Functions compilation.

Generate local reports:

```bash
make audit-site
```

The content audit writes reports to `reports/`; the link checker prints its
results. These audit steps are currently commented out in the push workflow.
CI runs unit tests, embedding refresh/indexing, and the production build/deployment. Developers run AI
corpus/fixture checks, model comparisons, and release gates locally.

### Pre-commit Hooks

The project uses [pre-commit](https://pre-commit.com/) for automated code quality checks:

- **File validation**: Large files, merge conflicts, YAML/TOML syntax
- **Formatting**: YAML, TOML, and Markdown formatting
- **Hugo-specific**: Front matter delimiters and large static-image checks
- **Spell checking**: Automated typo detection

### Setup Pre-commit

```bash
# Install pre-commit
pip install pre-commit

# Install hooks
pre-commit install

# Run all hooks manually
make pre-commit
```

### Go Module Management

Blowfish and shortcodes are managed through Hugo modules. Useful manual checks:

```bash
hugo mod tidy
hugo mod verify
```

The current pre-commit configuration does not run djLint, Go vulnerability
scanning, or a Hugo build; the build hook is commented out.

## 📝 Content Management

### Adding Blog Posts

1. Create a page bundle: `hugo new content posts/YYYY-MM-DD-my-new-post/index.md`
2. Add front matter including `title`, `date`, and `description`.
3. Keep featured images and other page resources in the same bundle.

### Adding Portfolio Projects

1. Create a new directory in `content/posts/YYYY-MM-DD-project-name/`
2. Add `index.md` with project details
3. Include project images and assets in the same directory

### Front Matter Example

```yaml
---
title: "My New Post"
date: 2024-01-01
tags: ["technology", "hugo"]
categories: ["blog"]
draft: false
description: "A concise description for metadata and sharing."
summary: "A brief description of the post"
---
```

## 🚀 Deployment

### Source metrics

```bash
make install-scc                 # Explicit install of pinned scc v4.1.0; requires Go 1.26.4+
export PATH="$(go env GOPATH)/bin:$PATH"
make metrics                     # Native per-language table; make bom is an alias
make metrics-json                # Native JSON to stdout
make --no-print-directory metrics-json > reports/source-metrics.json
```

Create `reports/` before redirecting a report there. Metrics commands never
install tools implicitly; `SCC=/path/to/scc` selects an existing binary.
The inventory measures the current working tree, including nonignored untracked
source, documentation, tests, configuration and RAG Markdown. It respects
`.gitignore` and excludes dependencies, build/cache/report trees, generated
purged CSS and dependency lock inventories. Binary images are not counted as
source lines.

The table shows files, total/blank/comment/code lines and approximate complexity,
with repository size; JSON retains native per-language metrics. Hugo templates
are classified by the tool rather than fully analyzed as Go-template programs.
Complexity is a heuristic, not a quality score, and generated site output remains
separate under `make build-summary`. COCOMO cost estimates are disabled.
`make bom` is a source inventory, **not** an SPDX/CycloneDX dependency SBOM.

### Layout validation

Run `make test-layouts` after changing Hugo overrides. The generated-output checks
cover structured-data types, the public `llms.txt` index, matching homepage image
preloads and restored Blowfish head settings. Internal `_context` documents stay
out of the public index. Homepage rendering and preloads share image selection;
picture preloads target the first AVIF source with its media type so unsupported
browsers can skip the hint rather than fetch an unused fallback.

The theme is pinned to Blowfish v3.9.0 via `github.com/nunocoracao/blowfish/v3`.
The supported Hugo range is 0.164.0–0.167.0.
The site uses the fixed-gradient header with dropdown mobile navigation and subtle
thumbnail hover zoom. Pages without featured images use the existing portrait
as their fallback social preview through `defaultSocialImage`.
The head override is reconciled with Blowfish v3.9.0. It retains the inline
appearance script, deferred accessibility/image-zoom scripts and mobile keyboard
viewport behavior; compare it with the pinned module again after theme upgrades.
Language redirects use the theme's corrected `Locale` lookup without a local
override. CI includes these layout checks.

### Build for Production

Make build/serve targets supply the current Git revision to Hugo through
`HUGO_BUILD_SHA`. The footer displays its first six characters at the bottom
right, linked to the full commit. Direct Hugo builds must supply
`HUGO_BUILD_SHA`; without a supplied revision the label is omitted.
`make serve` captures the revision when the server starts. Restart it after
committing or switching branches to refresh the footer; hot reload does not
refresh the server's environment. Uncommitted edits retain the last commit's SHA.

```bash
make build-prod
```

This generates the static site in the `public/` directory.

### Cloudflare Pages

The production branch is `develop`. The push workflow builds and deploys the
site to the `sg` Pages project. For a manual deployment:

```bash
make deploy-pages
```

This requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Use `make deploy-ai`
for an AI corpus/model activation, following the release procedure above.
Copying static output to another host does not provide the Cloudflare bindings
needed by the chat API.

## 🔧 Development Tips

### Local Testing

- Use `make serve` for development with hot reloading
- Test production builds with `make build-prod` before deployment
- Run `make pre-commit` to catch issues early

### Content Organization

- Use consistent date-based naming for posts
- Optimize images before adding to `assets/` or `static/`
- Keep image files under 1MB; pre-commit checks newly added large files and
  oversized static images

### Theme Updates

```bash
# Update the Blowfish theme
hugo mod get -u github.com/nunocoracao/blowfish/v3

# Check for theme-breaking changes
make build-prod
```

Review and commit the resulting `go.mod` / `go.sum` changes; do not vendor the theme.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `make pre-commit` to ensure code quality
5. Submit a pull request

## 📄 License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.

## 🔗 Links

- **Live site**: [samsongama.com](https://samsongama.com)
- **Hugo documentation**: [gohugo.io/documentation](https://gohugo.io/documentation/)
- **Blowfish theme**: [blowfish.page](https://blowfish.page/)
- **Repository**: [github.com/sgama/sg](https://github.com/sgama/sg)

---
