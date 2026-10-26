---
title: "Building a Serverless AI Chatbot for My Static Portfolio"
date: 2026-01-25
lastmod: 2026-10-26
slug: "ai-chat"
description: "How this Hugo portfolio answers visitor questions with a Cloudflare Worker, Workers AI and a versioned Vectorize corpus, with source excerpts, abstention and measured latency and cost."
summary: "A custom portfolio assistant with contextual follow-ups, streamed answers, public source evidence, explicit abstention and measurable latency and token cost."
tags: ["ai", "cloudflare", "hugo", "javascript", "rag"]
showDate: true
series: ["Cloudflare Developments"]
---

![Featured image](featured.webp)

Static sites are fast and cheap to host, but a visitor with a specific question still has to hunt through pages. I built a custom assistant for questions such as "What has Samson built at scale?" instead of embedding a generic chatbot iframe. The assistant can only answer from my published portfolio, shows the excerpts it used, and says so when the portfolio does not contain the answer.

This article describes the implementation as it stands in October 2026. The chunking, retrieval, abstention and cost reasoning are covered in depth in [How the RAG chatbot works](/posts/2026-01-26-website-stack/#how-the-rag-chatbot-works).

## What it is, and what it is not

The assistant uses **Retrieval-Augmented Generation (RAG)**: find relevant portfolio evidence, give that evidence to an answer model, and stream the answer back with the sources. It does not train or fine-tune a model, does not browse the web, and does not call tools.

{{< mermaid >}}
flowchart TB
    Q[Visitor question] --> R{Retrieve evidence}
    R -->|Portfolio sections found| G[Generate grounded answer]
    R -->|Too little evidence| A[Explicit abstention]
    G --> S[Streamed answer plus source excerpts]
    A --> S
{{< /mermaid >}}

The design goal is not a clever answer. It is a small system where each stage can be inspected, measured and changed without touching the others.

## The architecture

- **Frontend:** Hugo with Blowfish, a native `<dialog>` element and modular JavaScript. The chat code is isolated from the rest of the site.
- **API:** One Cloudflare Worker using Hono, serving `/api/chat` and `/api/logs`. Cloudflare serves the static site directly, and the Worker runs first only for `/api/*`, so ordinary page views never invoke it.
- **Inference:** Workers AI. GLM-4.7-Flash is the default answer and rewrite model.
- **Search:** Cloudflare Vectorize with BGE-base-en-v1.5 embeddings, 768 dimensions, in one index.
- **State:** Conversation history lives in the browser. Server-side response logging in KV is optional.

{{< mermaid >}}
flowchart LR
    Browser[Browser widget] -->|POST question and history| Worker[Worker /api/chat]
    Worker --> Embed[Workers AI embedding]
    Worker --> Rewrite[Workers AI rewrite]
    Embed --> Vec[(Vectorize, live namespace)]
    Vec --> Worker
    Worker --> Gen[Workers AI generation]
    Gen -->|SSE stream| Browser
    Static[Static site on Cloudflare] -.-> Browser
{{< /mermaid >}}

## From question to answer

The browser sends the question and a bounded slice of recent history. A first-turn question goes straight to embedding. A follow-up is rewritten into a standalone search query first. After "Tell me about Bitcomplete", the follow-up "What did he do before that?" becomes "What role did Samson hold before Bitcomplete?" for retrieval. Generation still receives the original question and the history, so the answer reads naturally.

The rewrite is necessary because embedding "before that?" alone retrieves nothing useful. It is also a point of failure: a bad rewrite changes what gets retrieved, so the rewritten query is part of the diagnostics.

{{< mermaid >}}
sequenceDiagram
participant User
participant Frontend
participant Function as Worker
participant VectorDB as Vectorize
participant AI as Workers AI
User->>Frontend: Ask a question
Frontend->>Function: POST query and bounded history
Function->>Function: Validate request and service bindings
opt Follow-up with history
    Function->>AI: Rewrite standalone search question
    AI-->>Function: Search question
end
Function-->>Frontend: Progress events
Function->>AI: Embed search question
AI-->>Function: Query vector
Function->>VectorDB: Search deployed namespace, top 3
VectorDB-->>Function: Matches
opt Referenced source sections
    Function->>VectorDB: Fetch section records
    VectorDB-->>Function: Canonical and parent evidence
end
Function->>Function: Expand, deduplicate and bound context
Function-->>Frontend: Public source excerpts
Function->>AI: Generate with context, history and query
AI-->>Function: Model stream
Function-->>Frontend: Normalized SSE answer and metrics
Frontend-->>User: Render answer and expandable sources
{{< /mermaid >}}

Three bounds keep the work predictable:

- **History:** at most four messages, 2,000 characters each and 4,000 characters in total.
- **Retrieval:** three matches. Referenced sections are capped at 6,000 characters each, and the assembled context at 12,000 characters.
- **Generation:** a 512-token completion budget.

These limits control cost and latency. They do not make an answer correct. Correctness depends on whether retrieval found the right evidence and whether the model used it faithfully.

### Answer outcomes

Every request ends in one of a few states. Making them explicit matters more than the happy path, because a chat widget that silently produces an empty answer is worse than one that fails loudly.

{{< mermaid >}}
stateDiagram-v2
    [*] --> Validating
    Validating --> Rejected: Bad body or missing binding
    Validating --> Retrieving
    Retrieving --> Abstained: Context under 20 characters
    Retrieving --> Generating
    Generating --> Answered: Model answers from context
    Generating --> Abstained: Model says context is insufficient
    Generating --> Failed: Provider or stream error
    Answered --> [*]
    Abstained --> [*]
    Failed --> [*]
    Rejected --> [*]
{{< /mermaid >}}

- **Abstention** happens in two layers. Retrieval that produces too little text (under 20 characters after trimming) returns a fixed message without calling the answer model. Otherwise the answer prompt instructs the model to say when the context does not cover the question. The first layer is deterministic; the second is only an instruction, not a verifier.
- **Rejected** requests return an HTTP error before any streaming starts. Oversized bodies are refused with 413 before the JSON is parsed.
- **Failed after streaming starts** becomes one error event followed by the end-of-stream marker, and the upstream model stream is cancelled. The client never sees an empty success.

## Building the knowledge base

Ingestion is the part most worth understanding, because the answer is only as good as the corpus behind it. `make ai-refresh` runs the maintained entry point, `scripts/generate_embeddings.mjs`, which uses the corpus modules under `scripts/lib/`.

The pipeline:

1. **Normalize.** Markdown and HTML are parsed structurally. Presentation controls are removed while lists, links and code survive.
2. **Map to public URLs.** Hugo's published-page export supplies canonical URLs, including slugs and permalink rules. Evidence can therefore link to the page a visitor would actually read.
3. **Chunk.** Level-one and level-two headings define sections. Long sections produce a bounded parent record and 2,000-character children with 200 characters of overlap.
4. **Link curated excerpts.** A short curated excerpt can point at a canonical public section, so the answer can cite the full section while keeping unique curated facts:

```yaml
retrievalSource: "content/resume/_index.md"
retrievalSection: "Professional Experience"
```

A historical internship hit, for example, can add the full newest-first employment section. Internal excerpts help generation but are never shown in the public source panel.

5. **Embed and index.** Workers AI produces 768-dimension vectors with `@cf/baai/bge-base-en-v1.5`. Records go to a new Vectorize namespace.
6. **Wait, then activate.** The deploy switches to the new namespace only after Vectorize reports the writes processed.

{{< mermaid >}}
flowchart LR
    Content[Markdown and front matter] --> AST[Structured normalization]
    Hugo[Hugo published URLs] --> Corpus[Validated versioned corpus]
    AST --> Corpus
    Corpus --> Embeddings[Workers AI embeddings]
    Embeddings --> Index[Vectorize candidate namespace]
    Index --> Ready[Wait for indexing]
    Ready --> Deploy[Deploy matching namespace]
{{< /mermaid >}}

Namespaces are derived from a hash of the corpus, and record IDs hash the namespace, the full source path and the chunk index. Two page bundles that both use `index.md` therefore cannot overwrite each other. Unchanged corpora skip ingestion. Changed corpora are re-embedded, which for this corpus is a fraction of a cent (an estimate, not a measured bill).

Versioned namespaces are what make rollback cheap. The previous namespace is retained after a deploy, so reverting the site does not require re-embedding. Older namespaces are deleted by cleanup after deployment.

## Why build retrieval instead of using Cloudflare AI Search?

Cloudflare AI Search can manage ingestion, chunking, indexing and retrieval—and optionally query rewriting, reranking and answer generation. I built those pieces because this corpus needs more than generic chunks: Hugo supplies canonical public URLs, curated excerpts can expand to validated parent sections, and each deploy activates an evaluated, versioned corpus. The custom pipeline also makes every retrieval step testable, but leaves parsing, chunking, indexing, cleanup and rollback operations to me.

{{< mermaid >}}
flowchart LR
    C[Custom: parse and chunk] --> E[Embed and index]
    E --> V[Versioned Vectorize namespace]
    V --> R[Custom retrieval and evidence]
    A[AI Search: ingest and chunk] --> M[Managed index and retrieval]
    M --> O[Search results or generated answer]
{{< /mermaid >}}

| | Custom pipeline | Cloudflare AI Search |
| --- | --- | --- |
| Control | Custom normalization, parent/canonical evidence, abstention and deployment gates | Managed indexing and retrieval, with configurable chunk size/overlap, metadata, hybrid search and optional reranking |
| Work | Maintain ingestion, validation, indexing, versioning, cleanup and evaluation | Less search infrastructure; adapt and revalidate corpus ingestion, evidence handling and API integration |
| Cost today | Workers AI embeddings and Vectorize; this small corpus rebuild is estimated at a fraction of a cent, and Vectorize has included monthly allowances | Open beta currently includes storage, indexing and crawling; Workers AI and AI Gateway remain billable |

**There is no measured savings claim here.** AI Search is currently free during its open beta (up to 20,000 monthly queries on Workers Free; paid plans have unlimited queries), while this small custom index is inexpensive and Vectorize usage may fit plan allowances. A move could reduce code and operations now, but actual savings depend on query volume, plan, model use and post-beta pricing. AI Search says it will give at least 30 days' notice before billing begins. See [AI Search pricing and limits](https://developers.cloudflare.com/ai-search/platform/limits-pricing/), [chunking controls](https://developers.cloudflare.com/ai-search/configuration/indexing/chunking/) and [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/).

## Retrieval and context

Retrieval embeds the search query with the same model used at ingestion and searches the namespace the live Worker is configured to read. The namespace filter is applied in the Vectorize query, so only records from the namespace the live Worker is configured to read are searched.

The retrieval stage returns three matches. Each match is a chunk. If a chunk belongs to a parent section, the parent is fetched so the model sees the surrounding context rather than a fragment. Duplicate sections are removed, canonical links are followed, and the assembled context is trimmed to the 12,000-character budget.

Retrieval results are cached by namespace and query, so a repeated question skips the paid embedding and search calls. The cache key includes the namespace, so a new deploy never serves answers from the previous corpus.

Retrieval is semantic only. It does not combine keyword scoring, reranking or metadata filters, which keeps the stage easy to reason about and easy to evaluate. Those are the first things to add if evaluation shows that exact terms such as product names are being missed.

## Generation and streaming

The answer prompt receives the original question, the bounded history, and the assembled context. It is instructed to answer only from the context, to cite the source excerpts shown to the visitor, and to say when the context does not contain the answer. Generation uses a 512-token budget and streams tokens back through the Worker.

The Worker normalizes the provider's stream into its own server-sent events: progress stages, answer text, metrics and a final end-of-stream marker. The browser therefore depends on one event contract, not on the provider's format. If the client disconnects, the Worker forwards the abort signal to the model call, although whether Workers AI stops inference on abort is not verified here.

Progress labels describe actual operations: understanding a follow-up, preparing search, finding sources, and writing an answer. An elapsed counter runs until answer text arrives. A failed request offers a manual Retry that reuses the original question and the history from before the request. There are no automatic paid retries.

## A native, inspectable chat window

The widget is a native `<dialog>` rather than an iframe, so it inherits the theme, supports keyboard controls and uses a full-height layout on phones. Starter questions introduce experience, projects, scale and the assistant itself.

**Retrieved sources** lists the public excerpts actually supplied to generation. This is evidence the model had, not proof that each sentence of the answer was checked against them. The panel makes that difference visible instead of hiding it.

Markdown renders with restricted markup. Mermaid diagrams load when the panel opens, and invalid or truncated diagrams keep their source with an explanation.

The diagnostics footer shows server-side total latency, time to first answer token, and the estimated answer and rewrite token cost. Details expands stage timings and token counts. When the provider omits usage, the field is shown as unavailable rather than zero, because a missing number is not the same as no cost. The cost estimate excludes embeddings, Vectorize, KV and hosting, which are small at this scale but not free.

Conversation history persists on the device across deployments until it is cleared manually. Clearing history does not delete server-side logs, which are stored separately.

## Verification and limits

```bash
make ai-check   # Corpus identities, Hugo URL provenance and evaluation labels
make test       # Offline regressions
make ai-build   # Bundle the Worker (dry run) with Node.js 22+
make dev-ai     # Local site with the chat API
```

The offline tests cover parsing preservation, section expansion, explicit errors, streaming, token accounting and deployment gates. Live evaluations are separate: they run retrieval and generation against labeled questions. For example, a recent-experience regression checks that the answer names Bitcomplete and Demonware and cites dated evidence, instead of accepting a plausible but vague internship summary. Those evaluations make paid calls and are run deliberately, not in CI.

### One measured baseline

A developer-run baseline on 2026-10-07 used 13 fixture questions, one GLM repetition and the live Vectorize corpus. Retrieval succeeded for all 13 requests, but only 10 of 12 labeled answerable questions retrieved an expected source in the top three (83.3%). Deterministic answer checks passed 5 of 13 (38.5%), and required regressions passed 1 of 7 (14.3%). First visible answer latency was 343 ms p50 / 537 ms p95; generation completed in 1,665 ms p50 / 4,846 ms p95. Estimated generation-only cost was $0.001487474.

**This did not pass the default 90% retrieval gate.** It is one diagnostic run, not a model ranking or a factual-accuracy score. The estimate excludes embeddings, Vectorize, storage and failed-call charges; timings are provider-facing, not full browser end-to-end latency. The [engineering notes](https://github.com/sgama/sg/blob/develop/README.md#measured-glm-baseline) include provenance and failure analysis.

The limits are real:

- Prompt instructions and pattern checks are not a complete security boundary. Edge rate limiting for the public chat endpoint is not configured in the repository.
- Semantic search can miss relevant evidence, especially when the visitor uses a term the portfolio never uses.
- Models can misinterpret dates, and an answer can combine true facts into a false claim.
- Term-based evaluations can show that expected terms appear. They cannot prove that an answer is entailed by its sources.
- Runtime deadlines, rate limits, human review and concurrency testing are the next steps, not finished work.

Static hosting can be inexpensive, but inference and storage have quotas and usage-based costs. The point of this architecture is not "free AI". It is a small, inspectable system in which retrieval, transport, quality and economics can each be measured on their own.
