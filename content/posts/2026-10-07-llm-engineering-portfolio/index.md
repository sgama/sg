---
title: "Engineering a Portfolio LLM: RAG, Tests, Latency, and Cost"
date: 2026-10-07
lastmod: 2026-11-24
slug: "llm-engineering-portfolio"
draft: true
description: "How this repository ships a versioned Cloudflare AI Search corpus, streams Workers AI answers through one search tool, and tests models for retrieval quality, latency, token usage, and cost."
summary: "A practical walkthrough of the developer work behind this portfolio's AI chat: corpus releases, managed search, streaming contracts, evaluation harnesses, and safe deployment."
tags: ["AI", "rag", "cloudflare", "testing", "reliability"]
series: ["Cloudflare Developments"]
showDate: true
---

The problem I had to solve was not getting a plausible answer from a prompt; it was making the portfolio chat retrieve relevant repository evidence, stream a stable response, and avoid serving a mismatched corpus after deployment. I built a versioned corpus release around **Hugo, a Cloudflare Worker with static assets, Workers AI (through AI Gateway), and Cloudflare AI Search**.

The repository builds the application and uploads its retrieval corpus; it does **not** train an LLM or build model weights. The sections below describe the implementation and its limits, not a claim that the system guarantees factual answers. The current design was rebuilt from an earlier Vectorize-based pipeline and **has not been deployed or evaluated yet**.

## 📌 How a question becomes an answer

```text
Browser question
  + bounded recent conversation
  -> Worker: validate input
  -> Workers AI model (streamText, system prompt, one searchPortfolio tool)
       -> model decides whether to search and writes a standalone query
       -> AI Search: hybrid vector + keyword retrieval, bge-reranker-base reranking
       -> model receives titles and text only (up to maxSteps = 3 searches)
  -> Stream adapter: normalize answer events, attach citations from chunk metadata
  -> Browser: render text/markdown and sources
```

For example, after "Tell me about Bitcomplete," a follow-up such as "What did he do before that?" leads the model to call the tool with something like "Samson's role before Bitcomplete". There is no separate rewrite call: the query is part of the model's tool call, and the evaluation checks it. First-turn greetings need no search. History is bounded to four messages, 2,000 characters per message and 4,000 characters total, rather than sending an ever-growing transcript.

AI Search chunks (2,000 characters, 200 overlap) and embeds with `@cf/baai/bge-base-en-v1.5`. An embedding represents semantic similarity; it is not an answer, a compressed copy of the document, or a modification to the generation model.

The shared registry supports GLM, Gemma, and Llama aliases. GLM is the default and Gemma then Llama are fallbacks: a model that fails before producing output hands the turn to the next one. GLM and Gemma have thinking disabled. Generation has a **512-token completion budget**, using each provider's supported parameter name.

Search returns up to six results above a 0.4 match threshold, with one chunk of context expansion, and the tool output is capped at **12,000 characters**. Character limits are not token limits.

The nine-line system prompt tells the model to answer only from search results and to say the information is insufficient otherwise. That is the only abstention layer; there is no deterministic check on the retrieved text any more. Missing service bindings return HTTP errors before streaming begins. Failures after the SSE connection opens produce an error event, not a fabricated answer or an empty successful response.

## 📌 What the chat window shows

Starter questions offer entry points into experience, projects, scale and the assistant itself. While work happens, the widget reports actual backend stages:

```text
🔎 Finding sources...
✍️ Writing answer...
```

An elapsed-time counter runs until the first answer text arrives. A failed answer offers a manual **Retry** using the original question and pre-request history; there are no automatic paid retries.

**Retrieved sources** exposes public links built from chunk metadata. The model never sees or writes URLs. Citations are page-level, so an employment answer shows the resume page rather than a specific section. Internal context files are not exposed, and retrieval is supporting evidence, not independent verification of every claim.

Answers also have a compact diagnostics footer:

```text
🕧9.36s · 🪙8.74s · 💲0.000108 · Details
```

These illustrative values mean server-side total time, time to first answer token, and estimated LLM token cost. **Details** opens the model that answered and its token usage. Missing usage displays "Cost unavailable," not zero.

Conversation history is saved on the device and survives website deployments. **Clear History** removes that saved browser conversation; it does not delete any separately stored server-side logs.

## 📌 Building and uploading the corpus

The ingestion script reads Markdown and skips drafts, empty bodies and heading-only sections. Structured Markdown and HTML syntax trees remove presentation-only markup and images while preserving nested lists, links and code. A quote-aware tokenizer handles Hugo shortcodes outside Markdown code. For example, a portrait shortcode is not useful evidence, but text inside a button shortcode is retained.

Chunking and embedding now belong to AI Search, so the repository only uploads source files and metadata. Curated excerpts can explicitly point to a public canonical page:

```yaml
retrievalSource: "content/resume/_index.md"
retrievalSection: "Professional Experience"
```

`retrievalSource` sets the citation URL. `retrievalSection` is ignored, since citations are page-level. Public URLs come from Hugo's published-page export, respecting slugs and permalink rules rather than guessing from filenames; internal documents remain searchable but do not receive public URLs. Missing, ambiguous, empty or non-public targets fail validation instead of silently citing the wrong page.

The corpus identity prevents accidental data loss: an instance is named `portfolio-<12 hex of the corpus hash>`, where the hash covers source contents and chunking/search configuration. A changed corpus therefore becomes a new instance and never mutates the live one.

Uploads do not retry and abort on the first failure. The refresh script waits until every item is indexed before it sets `AI_SEARCH_INSTANCE` for the deployment.

A push to `develop` refreshes the corpus and deploys the matching instance only when a deployable input changed; otherwise the pipeline skips both. An unchanged corpus skips ingestion. Failed ingestion prevents deployment. The site is one live Worker version, so `make cleanup-instances` keeps the live instance and the one it replaced (for rollback without re-indexing) and deletes older `portfolio-*` instances. It stops if a deploy changes the live instance mid-run, and refuses to run if it cannot determine it.

## 📌 Developing and verifying the integration

The application is built locally before any paid evaluation:

```bash
make ai-check   # Validate corpus identities and evaluation labels
make test       # Run offline unit and integration-style tests
make ai-build   # Bundle the Worker (dry run); requires Node.js 22+
make dev-ai     # Run Hugo output with Wrangler and the chat API
```

Tests use mock AI and AI Search services. They verify input validation, explicit failures, model fallback, ingestion transport, indexing readiness, and deployment gates.

Streaming needs its own contract tests. Some models emit `{"response":"..."}`; others emit `choices[0].delta.content`. The server converts both to the widget's answer format, handles fragmented UTF-8 and completion markers, and excludes reasoning. An empty or malformed answer must produce an error, not an empty successful chat bubble.

Passing mocks proves application behavior, **not live provider availability, model quality, or production performance**. Those require separate live checks.

## 📌 The evaluation harness

A harness is the code that runs fixed inputs, captures outputs, and applies repeatable measurements. This repository uses a small labeled JSON fixture with:

- A stable case ID and question.
- Expected source paths for retrieval.
- Groups of acceptable answer terms.
- Forbidden terms and an unanswerable example.

For example, "Summarize Samson's recent engineering experience" checks for Bitcomplete, Demonware and 2026 evidence. A follow-up regression checks the role before Bitcomplete. Negative cases cover facts the portfolio does not establish, such as availability or compensation, rather than encouraging invented answers.

Retrieval **hit@5** (an expected source among the top results) is the fraction of labeled, answerable questions whose results include an expected source. It is not precision, complete recall, or proof that the answer is grounded.

The evaluation runs on [promptfoo](https://www.promptfoo.dev/) with a custom provider that calls the production `runTurn`. Four checks gate the run: the model **searched**, **retrieval-hit**, the issued **query** kept the conversation's subject, and **links** in the answer are acceptable. Term-based evidence and answer checks are reported without gating. Compare models by adding provider entries to the config:

```bash
make ai-plan
make ai-audit AI_INSTANCE=portfolio-HASH_FROM_PLAN  # ingest the candidate, then evaluate it
```

These live commands incur charges.

For reference, the last measured run was on the previous Vectorize-based pipeline (2026-11-20, 74 questions): 67 passed, retrieval hit 61 of 64, and 1 of 5 follow-up rewrites kept the subject. **The new pipeline has not been evaluated**, so those numbers do not describe it.

Answer checks currently match terms, not factual entailment. Negative cases test answers against what search returned; they do not guarantee that the model rejects every unknown fact or misleading excerpt. Human review and a larger, held-out dataset are still necessary.

## 📌 Latency and throughput

| Metric | What it means here |
| --- | --- |
| Total time | Server-side time from the start of the request to completion |
| TTFT | Time from the start of the request to first visible answer text |
| Model | The model that answered, after any fallback |
| Token usage | Provider-reported usage, or `null` when missing |

The widget diagnostics report these per request; there are no separate embedding or search timings, and no aggregate p50/p95 benchmark exists since the evaluation moved to promptfoo.

The widget's first-token metric starts when the request begins, so it includes every search the model makes before it answers. The browser's pending counter includes client waiting, but is not a persisted end-to-end performance measurement. Do not simply add stage p95 values: the p95 of a sum is not generally the sum of p95s.

For credible comparisons, hold prompts, contexts, and output limits constant; label warm/cold and cached/uncached runs; use enough samples to make tail percentiles meaningful. A serial harness is **not** a requests-per-second or concurrency load test. Those need controlled arrival rates, concurrent clients, and error/saturation measurements.

## 📌 Token usage and cost

Input tokens include system instructions, search results, the question and bounded history. Because the model may search more than once, a turn can consume several steps. Output budgets can include reasoning depending on the provider; do not equate visible text length with billable output.

The adapter preserves aggregate usage rather than summing incremental events and then counting a final summary again. Server-side request logs (question, answer and usage) live in AI Gateway and Workers Logs and are separate from the device's saved conversation.

```text
Estimated generation cost =
  input tokens  * input price per million  / 1,000,000
  + output tokens * output price per million / 1,000,000
```

For illustration, at the registry's dated GLM prices of **$0.0605/M input** and **$0.40/M output**, 1,200 input plus 200 output tokens costs approximately **$0.000153** in generation. This is arithmetic, not a measured invoice; verify current pricing before using it.

The reports exclude AI Search, failed-call charges, and account allowances. Missing usage is `null`, not zero. Evaluate **total spend per successful answer**, including retries and failures, before claiming savings.

Shorter useful context and concise answers reduce token work. The only cache is AI Search's own query cache; there is no exact-answer cache, semantic cache or provider prefix caching in this chat path.

## 📌 Release discipline and developer responsibilities

Routine content refresh belongs in production CI. Model selection and quality review belong in a deliberate developer workflow. The local release gate (`make ai-eval`) passes when the gating checks reach `AI_PASS_RATE`, 90% by default; this is a configured acceptance threshold, not an achieved production metric.

The work an LLM application developer needs to own is concrete:

1. **Data:** source provenance, permissions, parsing, corpus identity, indexing, and deletion behavior.
2. **Contracts:** prompt construction, provider schemas, streaming, tool validation, and typed boundaries.
3. **Evaluation:** representative held-out cases, negative tests, regression checks, and human review.
4. **Performance:** stage timing, output budgets, tail latency, concurrency, and cancellation.
5. **Economics:** token accounting, indexing costs, cache effectiveness, and cost per successful task.
6. **Operations:** release manifests, rollback, timeouts, rate limits, telemetry, retention, and incident diagnosis.

This repository implements parts of that foundation, not the entire list. Spend caps, Turnstile, server-side sessions, durable production stage traces, section-level citations, claim-by-claim citation verification and concurrency load testing remain work to do. Visible source links do not prove factual correctness. There is no input filter, and prompt instructions are not a security boundary: retrieved documents must be treated as untrusted, and the single search tool is read-only; any future tools need explicit authorization.

On Workers AI, Cloudflare operates GPU scheduling, batching, and model serving, and AI Search operates chunking, embedding and indexing. This application cannot directly tune VRAM, FLOPS, quantization kernels, KV-cache allocation or the managed chunker beyond its configuration. Self-hosted inference adds those responsibilities, plus capacity planning and model artifact management.

The practical lesson is simple: **separate retrieval quality, generation quality, transport correctness, latency, and cost**. A model can excel at one and fail at another; an engineering harness makes those differences visible before they reach users.
