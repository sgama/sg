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
  -> Pages Function: validate input and check guardrails
  -> Workers AI: embed the question
  -> Vectorize: retrieve three chunks from the deployed corpus namespace
  -> Prompt: system instructions + retrieved text + question
  -> Workers AI: generate a streamed answer
  -> Stream adapter: normalize answer events and discard reasoning
  -> Browser: render text/markdown; KV: save the transcript and usage
```

The embedding model is `@cf/baai/bge-base-en-v1.5`, producing **768-dimensional vectors**. An embedding represents semantic similarity; it is not an answer, a compressed copy of the document, or a modification to the generation model.

The shared registry supports GLM, Gemma, and Llama aliases. GLM is the default; GLM and Gemma have thinking disabled. Generation has a **512-token completion budget**, using each provider's supported parameter name.

Retrieval selects **top three matches** and limits assembled context to **12,000 characters**. Character limits are not token limits. The current implementation has no reranker, hybrid lexical search, or calibrated similarity threshold. Short context triggers abstention; a retrieval outage returns 503 instead of pretending nothing relevant was found.

## Building and embedding the corpus

The ingestion pipeline reads Markdown, skips drafts and empty bodies, and splits text into **2,000-character chunks with 200-character overlap**. It stores chunk text, source path, title, and content type with each vector. Internal context documents are searchable but do not receive public URLs.

Two important identities prevent accidental data loss:

- **Corpus namespace:** a deterministic hash of source contents and embedding/chunk configuration.
- **Chunk ID:** a hash incorporating the namespace, full source path, and chunk index.

Using only the filename would make unrelated `index.md` bundles overwrite one another. Versioned IDs also keep a candidate corpus separate from the serving version.

Ingestion uses bounded concurrency, validates vector dimensions and finite values, uploads NDJSON, and fails on incomplete work. Upsert acceptance is asynchronous: the refresh script waits for each mutation to finish indexing before updating the deployment namespace.

Every production push to `develop` rebuilds embeddings and deploys the matching namespace. Failed ingestion prevents deployment; older namespaces remain available. This currently regenerates all embeddings, even for unchanged content, so incremental reuse and namespace cleanup are future cost improvements.

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

Answer checks currently match terms, not factual entailment. The unanswerable case uses empty context to test application abstention; it does not prove the model rejects unknown facts when retrieval returns misleading text. Human review and a larger, held-out dataset are still necessary.

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

For credible comparisons, hold prompts, contexts, and output limits constant; label warm/cold and cached/uncached runs; use enough samples to make tail percentiles meaningful. This serial harness is **not** a requests-per-second or concurrency load test. Those need controlled arrival rates, concurrent clients, and error/saturation measurements.

## Token usage and cost

Input tokens include system instructions, context, the question, and any history. The backend accepts bounded history, but the current widget sends only the question. Output budgets can include reasoning depending on the provider; do not equate visible text length with billable output.

The adapter preserves aggregate usage rather than summing incremental events and then counting a final summary again. Logs store full transcripts in KV values, not its size-limited metadata.

```text
Estimated generation cost =
  input tokens  * input price per million  / 1,000,000
  + output tokens * output price per million / 1,000,000
```

For illustration, at the registry's dated GLM prices of **$0.0605/M input** and **$0.40/M output**, 1,200 input plus 200 output tokens costs approximately **$0.000153** in generation. This is arithmetic, not a measured invoice; verify current pricing before using it.

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

This repository implements parts of that foundation, not the entire list. Runtime deadlines/rate limits, production stage traces, relevance calibration, automated citations, and load testing remain work to do. Prompt-pattern checks are not a complete security boundary: retrieved documents must be treated as untrusted, and any future tools need explicit authorization.

On Workers AI, Cloudflare operates GPU scheduling, batching, and model serving. This application cannot directly tune VRAM, FLOPS, quantization kernels, or KV-cache allocation. Self-hosted inference adds those responsibilities, plus capacity planning and model artifact management.

The practical lesson is simple: **separate retrieval quality, generation quality, transport correctness, latency, and cost**. A model can excel at one and fail at another; an engineering harness makes those differences visible before they reach users.
