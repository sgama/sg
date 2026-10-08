---
title: "Building a Serverless AI Chatbot for My Static Portfolio"
date: 2026-01-25
lastmod: 2026-10-07
slug: "ai-chat"
description: "How this Hugo portfolio uses Cloudflare Pages Functions, Workers AI and a versioned Vectorize corpus to answer questions with source excerpts."
summary: "A custom portfolio assistant with contextual follow-ups, streamed answers, public source evidence and measurable latency and token cost."
tags: ["ai", "cloudflare", "hugo", "javascript", "rag"]
showDate: true
series: ["Cloudflare Developments"]
---

![Featured image](featured.webp)

Static sites are fast and straightforward to host, but visitors still need a way to find relevant information. I built a custom assistant for questions such as "What has Samson built at scale?" rather than embedding a generic chatbot iframe. This article describes the current implementation, updated in October 2026.

## The architecture

The assistant uses **Retrieval-Augmented Generation (RAG)**: find relevant portfolio evidence, supply it to an answer model, and stream the response. It does not train a model or browse the web.

- **Frontend:** Hugo with Blowfish, a native dialog and modular JavaScript.
- **API:** Cloudflare Pages Functions with Hono at `/api/chat`.
- **Inference:** Workers AI; GLM-4.7-Flash is the default answer and rewrite model.
- **Search:** Cloudflare Vectorize with BGE-base-en-v1.5 embeddings, 768 dimensions.
- **State:** Browser conversation history, plus optional server-side KV response logging.

## From question to answer

The browser sends a question and bounded recent history. First-turn questions go straight to embedding. Follow-ups are rewritten for search: after "Tell me about Bitcomplete," "What did he do before that?" can become "What role did Samson hold before Bitcomplete?" Generation still receives the original question and history.

{{< mermaid >}}
sequenceDiagram
participant User
participant Frontend
participant Function as Pages Function
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

History is bounded to four messages, 2,000 characters each and 4,000 characters total. Retrieval selects three matches; expanded sections are capped at 6,000 characters and the assembled context at 12,000. The answer has a 512-token completion budget. These bounds control work, not factual correctness.

Insufficient context produces an explicit abstention without calling the answer model. Missing bindings return HTTP errors before streaming. Failures after SSE begins become error events instead of an empty successful answer.

## Building the knowledge base

`make ai-refresh` coordinates the maintained ingestion entry point, `scripts/generate_embeddings.mjs`, and corpus modules. Structured Markdown/HTML parsing removes presentation controls while preserving lists, links and code. Hugo's published-page export supplies canonical URLs, including slugs and permalink rules.

Level-one/two headings define sections. Long sections produce bounded parent records and 2,000-character children with 200-character overlap. Curated excerpts can supplement themselves with a canonical public section:

```yaml
retrievalSource: "content/resume/_index.md"
retrievalSection: "Professional Experience"
```

For example, a historical internship hit can add the full newest-first employment section while retaining unique curated facts. Internal excerpts help generation but are not exposed in the public source panel.

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

Corpus namespaces and record IDs include content/configuration identity and full source paths. Different page bundles cannot overwrite each other merely because both use `index.md`. Unchanged corpora skip ingestion; changed corpora are re-embedded. Indexing must complete before deployment proceeds.

## A native, inspectable chat window

Starter questions introduce experience, projects, scale and the assistant itself. The widget respects the theme, supports keyboard controls and uses a full-height mobile layout.

Progress labels reflect actual operations: understanding a follow-up, preparing search, finding sources and writing an answer. An elapsed counter runs until answer text arrives. Failed requests offer a manual Retry using the original question and pre-request history; there are no automatic paid retries.

**Retrieved sources** displays public excerpts actually supplied to generation, not a claim that each answer sentence was independently verified. Markdown renders with restricted markup. Mermaid diagrams load when the panel opens; invalid or truncated diagrams retain their source with an explanation.

The diagnostics footer shows server-side total latency, time to first answer token and estimated answer/rewrite token cost. Details expands stage timings and token counts. Missing provider usage is unavailable, not zero; the estimate excludes embeddings, Vectorize, KV and hosting.

Conversation history persists on the device across deployments until manually cleared. Clear History does not delete separately stored server-side logs.

## Verification and limits

```bash
make ai-check   # Corpus identities, Hugo URL provenance and evaluation labels
make test       # Offline regressions; ai-test is a compatibility alias
make ai-build   # Compile Functions with Node.js 22+
make dev-ai     # Local site with the chat API
```

Tests cover parsing preservation, section expansion, explicit errors, streaming, token accounting and deployment gates. Live evaluations separately test retrieval and generation against labeled questions. For example, a recent-experience regression checks for Bitcomplete, Demonware and dated evidence instead of accepting a plausible internship summary.

Prompt instructions and pattern checks are not a complete security boundary. Semantic search can miss relevant evidence, models can misinterpret dates, and term-based evaluations cannot prove factual entailment. Runtime deadlines, rate limits, human review and concurrency testing remain useful next steps.

Static hosting can be inexpensive, but AI inference and storage have quotas and usage-based costs. The point of this architecture is not "free AI": it is a small, inspectable system whose retrieval, transport, quality and economics can be measured separately.
