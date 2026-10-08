---
title: "Engineering a Portfolio LLM: RAG, Tests, Latency, and Cost"
date: 2026-10-07
slug: "llm-engineering-portfolio"
draft: true
description: "How this repository builds a versioned RAG corpus, streams Workers AI answers, and tests models for retrieval quality, latency, token usage, and cost."
summary: "A practical walkthrough of the developer work behind this portfolio's AI chat: ingestion, vector search, streaming contracts, evaluation harnesses, and safe deployment."
tags: ["ai", "rag", "cloudflare", "testing", "observability", "devops"]
series: ["Cloudflare Developments"]
showDate: true
---

An LLM integration is not finished when a prompt returns a plausible answer. It needs a reproducible knowledge pipeline, a stable API contract, measurable quality, and a deployment that cannot silently serve broken data.

This portfolio uses **Hugo, Cloudflare Pages Functions, Workers AI, Vectorize, and KV**. The repository builds the application and its retrieval corpus; it does **not** train an LLM or build model weights.

## How a question becomes an answer

```text
Browser question
  + bounded recent conversation
  -> Pages Function: validate input and check prompt-pattern guardrails
  -> Workers AI: rewrite a follow-up into a standalone search question
  -> Workers AI: embed the search question
  -> Vectorize: retrieve three matches from the deployed corpus namespace
  -> Expand matching excerpts into bounded source sections; deduplicate
  -> Prompt: system instructions + retrieved text + history + original question
  -> Workers AI: generate a streamed answer
  -> Stream adapter: normalize answer events and discard reasoning
  -> Browser: render text/markdown; KV: save the transcript and usage
```

For example, after "Tell me about Bitcomplete," a follow-up such as "What did he do before that?" can be rewritten as "What role did Samson hold before Bitcomplete?" The rewrite guides search; the original question and recent conversation still guide the answer. First-turn questions skip rewriting. History is bounded to four messages, 2,000 characters per message and 4,000 characters total, rather than sending an ever-growing transcript.

The embedding model is `@cf/baai/bge-base-en-v1.5`, producing **768-dimensional vectors**. An embedding represents semantic similarity; it is not an answer, a compressed copy of the document, or a modification to the generation model.

The shared registry supports GLM, Gemma, and Llama aliases. GLM is the default; GLM and Gemma have thinking disabled. Generation has a **512-token completion budget**, using each provider's supported parameter name.

Retrieval selects **top three matches** and limits assembled context to **12,000 characters**, with expanded sections capped at **6,000 characters** each. Character limits are not token limits. The current implementation has no reranker, hybrid lexical search, or calibrated similarity threshold.

Insufficient context triggers an explicit abstention without calling the answer model. Missing service bindings return HTTP errors before streaming begins. Failures after the SSE connection opens produce an error event, not a fabricated answer or an empty successful response.

## What the chat window shows

Starter questions offer entry points into experience, projects, scale and the assistant itself. While work happens, the widget reports actual backend stages:

```text
🧠 Understanding your follow-up...   (only when rewriting)
🧩 Preparing source search...
🔎 Finding sources...
✍️ Writing answer...
```

An elapsed-time counter runs until the first answer text arrives. A failed answer offers a manual **Retry** using the original question and pre-request history; there are no automatic paid retries.

**Retrieved sources** exposes public links and the bounded excerpts supplied to generation. For example, an employment answer might show the resume's Professional Experience section. Internal context files are not exposed, and retrieval is supporting evidence, not independent verification of every claim.

Answers also have a compact diagnostics footer:

```text
🕧9.36s · 🪙8.74s · 💲0.000108 · Details
```

These illustrative values mean server-side total time, time to first answer token, and estimated LLM token cost. **Details** opens stage timings and answer/rewrite token counts. Missing usage displays "Cost unavailable," not zero. The header shows the configured answer, rewrite and embedding models.

Conversation history is saved on the device and survives website deployments. **Clear History** removes that saved browser conversation; it does not delete any separately stored server-side logs.

## Building and embedding the corpus

The ingestion pipeline reads Markdown and skips drafts, empty bodies and heading-only sections. Structured Markdown and HTML syntax trees remove presentation-only markup and images while preserving nested lists, links and code. A quote-aware tokenizer handles Hugo shortcodes outside Markdown code. For example, a portrait shortcode is not useful evidence, but text inside a button shortcode is retained.

Level-one and level-two headings define source sections; level-three headings stay with their enclosing section. Long sections produce bounded parent records and **2,000-character child chunks with 200-character overlap**. A matching child can retrieve its parent so generation sees related facts together rather than one isolated fragment. Sibling matches are deduplicated.

Curated excerpts can explicitly point to a public canonical section:

```yaml
retrievalSource: "content/resume/_index.md"
retrievalSection: "Professional Experience"
```

For example, a hit on a historical internship excerpt adds the resume's newest-first employment section while retaining unique curated facts within the context budget. Canonical linkage supplements evidence; ordinary child-to-parent expansion replaces fragmented child text with its enclosing section. Only public excerpts are displayed to visitors. Missing, ambiguous, empty, non-public or oversized targets fail validation instead of silently using the wrong evidence.

Embedding inputs include page and section labels, such as `Resume — Professional Experience`, followed by normalized source text. Each vector includes source path, title and content type. Public URLs come from Hugo's published-page export, respecting slugs and permalink rules rather than guessing from filenames; internal documents remain searchable but do not receive public URLs.

Two important identities prevent accidental data loss:

- **Corpus namespace:** a deterministic hash of source contents and embedding/chunk configuration.
- **Chunk ID:** a hash incorporating the namespace, full source path, and chunk index.

Using only the filename would make unrelated `index.md` bundles overwrite one another. Versioned IDs also keep a candidate corpus separate from the serving version.

Ingestion uses bounded concurrency, validates vector dimensions and finite values, uploads NDJSON, and fails on incomplete work. Upsert acceptance is asynchronous: the refresh script waits for each mutation to finish indexing before updating the deployment namespace.

Every production push to `develop` refreshes the corpus and deploys the matching namespace. An unchanged corpus skips ingestion; a changed corpus is re-embedded. Failed ingestion prevents deployment. Cleanup prunes old deployments and unreferenced versioned corpora while protecting namespaces used by retained deployments. Reusing individual embeddings across changed corpora remains a future cost improvement.

## Developing and verifying the integration

The application is built locally before any paid evaluation:

```bash
make ai-check   # Validate corpus identities and evaluation labels
make ai-test    # Run offline unit and integration-style tests
make ai-build   # Compile Pages Functions; requires Node.js 22+
make dev-ai     # Run Hugo output with Wrangler and the chat API
```

Tests use mock AI, Vectorize, and KV services. They verify input validation, explicit failures, namespace selection, ingestion transport, indexing readiness, log persistence, and deployment gates.

Streaming needs its own contract tests. Some models emit `{"response":"..."}`; others emit `choices[0].delta.content`. The server converts both to the widget's answer format, handles fragmented UTF-8 and completion markers, and excludes reasoning. An empty or malformed answer must produce an error, not an empty successful chat bubble.

Passing mocks proves application behavior, **not live provider availability, model quality, or production performance**. Those require separate live checks.

## The evaluation harness

A harness is the code that runs fixed inputs, captures outputs, and applies repeatable measurements. This repository uses a small labeled JSON fixture with:

- A stable case ID and question.
- Expected source paths for retrieval.
- Groups of acceptable answer terms.
- Forbidden terms and an unanswerable example.

For example, "Summarize Samson's recent engineering experience" checks for Bitcomplete, Demonware and 2026 evidence. A follow-up regression checks the role before Bitcomplete. Negative cases cover facts the portfolio does not establish, such as availability or compensation, rather than encouraging invented answers.

Retrieval **hit@3** is the fraction of labeled, answerable questions whose top three results include an expected source. It is not precision, complete recall, or proof that the answer is grounded.

Model comparisons have two modes:

```bash
# Isolate generation: give each model identical labeled-source contexts
make ai-compare AI_MODELS=glm,gemma,llama AI_REPEATS=3

# Evaluate retrieval once, then reuse its contexts across models
make ai-plan
make ai-embeddings AI_NAMESPACE=corpus-HASH_FROM_PLAN
make ai-retrieval-eval AI_NAMESPACE=corpus-HASH_FROM_PLAN
make ai-compare-rag AI_NAMESPACE=corpus-HASH_FROM_PLAN AI_MODELS=glm,gemma
```

These live commands incur charges. Comparisons are serial, interleaved by case/model, and bounded by timeouts and repeat limits. Reports record corpus, fixture, prompt, and model settings so incompatible results cannot pass the local release gate.

Answer checks currently match terms, not factual entailment. An empty-context case tests application abstention; other negative cases test answers against retrieved context. Neither guarantees that the model rejects every unknown fact or misleading excerpt. Human review and a larger, held-out dataset are still necessary.

## Latency and throughput

| Metric | What it means here |
| --- | --- |
| Embedding latency | Time to obtain the query vector |
| Search latency | Time for the Vectorize query |
| TTFT | Time from generation request start to first visible answer text |
| Completion latency | Time from generation request start to stream completion |
| Inter-chunk gap | Time between visible streamed answer chunks |
| Completion tokens/second | Provider completion tokens divided by total generation duration |

The harness reports p50/p95 TTFT, p95 completion latency, and inter-chunk timing. **SSE chunks are not tokens**, so inter-chunk latency is not token latency. The tokens/second estimate includes prefill and first-answer delay; it is not isolated GPU decode throughput.

Generation benchmarks exclude retrieval and browser rendering. To measure user experience, instrument browser send-to-first-answer and send-to-completion separately. Do not simply add stage p95 values: the p95 of a sum is not generally the sum of p95s.

The widget's first-token metric differs from the generation-only benchmark: it starts when the server creates the AI service, so it includes rewriting, embedding and retrieval. The browser's pending counter includes client waiting, but is not a persisted end-to-end performance measurement.

For credible comparisons, hold prompts, contexts, and output limits constant; label warm/cold and cached/uncached runs; use enough samples to make tail percentiles meaningful. This serial harness is **not** a requests-per-second or concurrency load test. Those need controlled arrival rates, concurrent clients, and error/saturation measurements.

## Token usage and cost

Input tokens include system instructions, context, the question and bounded history sent by the widget. Follow-ups also incur a separate rewrite call. Output budgets can include reasoning depending on the provider; do not equate visible text length with billable output.

The adapter preserves aggregate usage rather than summing incremental events and then counting a final summary again. When configured, KV logging stores the question, streamed answer and answer-model usage in values, not size-limited metadata; it is separate from the device's saved conversation.

```text
Estimated generation cost =
  input tokens  * input price per million  / 1,000,000
  + output tokens * output price per million / 1,000,000
```

For illustration, at the registry's dated GLM prices of **$0.0605/M input** and **$0.40/M output**, 1,200 input plus 200 output tokens costs approximately **$0.000153** in generation. This is arithmetic, not a measured invoice; verify current pricing before using it.

The response footer adds estimated answer and rewrite token costs. If either required usage record is missing, the combined estimate is unavailable.

The reports exclude embeddings, Vectorize, KV, failed-call charges, and account allowances. Missing usage is `null`, not zero. Evaluate **total spend per successful answer**, including retries and failures, before claiming savings.

Shorter useful context and concise answers reduce token work. Caching may avoid work altogether, but exact-answer caching, semantic caching, and provider prefix caching are different mechanisms. None is currently implemented in this chat path.

## Release discipline and developer responsibilities

Routine content refresh belongs in production CI. Model selection and quality review belong in a deliberate developer workflow. The local release gate defaults to **90% retrieval hit rate** and **80% answer checks**; these are configured acceptance thresholds, not achieved production metrics.

The work an LLM application developer needs to own is concrete:

1. **Data:** source provenance, permissions, parsing, chunk identity, indexing, and deletion behavior.
2. **Contracts:** prompt construction, provider schemas, streaming, tool validation, and typed boundaries.
3. **Evaluation:** representative held-out cases, negative tests, regression checks, and human review.
4. **Performance:** stage timing, output budgets, tail latency, concurrency, and cancellation.
5. **Economics:** token accounting, ingestion costs, cache effectiveness, and cost per successful task.
6. **Operations:** release manifests, rollback, timeouts, rate limits, telemetry, retention, and incident diagnosis.

This repository implements parts of that foundation, not the entire list. Runtime deadlines/rate limits, durable production stage traces, relevance calibration, claim-by-claim citation verification and concurrency load testing remain work to do. Visible source excerpts and model-generated links do not prove factual correctness. Prompt-pattern checks are not a complete security boundary: retrieved documents must be treated as untrusted, and any future tools need explicit authorization.

On Workers AI, Cloudflare operates GPU scheduling, batching, and model serving. This application cannot directly tune VRAM, FLOPS, quantization kernels, or KV-cache allocation. Self-hosted inference adds those responsibilities, plus capacity planning and model artifact management.

The practical lesson is simple: **separate retrieval quality, generation quality, transport correctness, latency, and cost**. A model can excel at one and fail at another; an engineering harness makes those differences visible before they reach users.
