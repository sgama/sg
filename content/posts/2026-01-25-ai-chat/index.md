---
title: "Building a Serverless AI Chatbot for My Static Portfolio"
date: 2026-01-25
lastmod: 2026-11-24
slug: "ai-chat"
description: "How this Hugo portfolio answers visitor questions with a Cloudflare Worker, Workers AI and a versioned Cloudflare AI Search instance, with source citations, abstention and measured latency and cost."
summary: "A portfolio assistant where the model decides when to search, with streamed answers, public source citations, explicit abstention and measurable latency and token cost."
tags: ["AI", "cloudflare", "hugo", "javascript", "rag"]
showDate: true
series: ["Cloudflare Developments"]
---

![Featured image](featured.webp)

Static sites are fast and cheap to host, but a visitor with a specific question still has to hunt through pages. I built a custom assistant for questions such as "What has Samson built at scale?" instead of embedding a generic chatbot iframe. The assistant can only answer from my published portfolio, shows the excerpts it used, and says so when the portfolio does not contain the answer.

This article describes the implementation as it stands in November 2026. The assistant was rebuilt around managed Cloudflare AI Search; that design has not been deployed or evaluated yet, and the evaluation numbers below belong to the previous pipeline.


## 🎯 What it is, and what it is not

The assistant uses **Retrieval-Augmented Generation (RAG)**: search the portfolio, give what comes back to an answer model, and stream the answer with its sources. It does not train or fine-tune a model and does not browse the web. Its one tool, `searchPortfolio`, searches my own content.

{{< mermaid >}}
flowchart TB
    Q[Visitor question] --> M{Model decides}
    M -->|Needs a fact| S[searchPortfolio]
    M -->|Greeting or small talk| G[Answer directly]
    S --> G2[Generate answer from results]
    G2 -->|Results do not establish it| A[Explicit abstention]
    G2 --> O[Streamed answer plus citations]
    G --> O
    A --> O
{{< /mermaid >}}

The design goal is not a clever answer. It is a small system where each stage can be inspected, measured and changed without touching the others.

## 🏗️ The architecture

- **Frontend:** Hugo with Blowfish, a native `<dialog>` element and modular JavaScript. The chat code is isolated from the rest of the site.
- **API:** One Cloudflare Worker using Hono (body limit, zod validation, secure headers), serving `/api/chat`; model calls go through AI Gateway. Cloudflare serves the static site directly, and the Worker runs first only for `/api/*`, so ordinary page views never invoke it.
- **Orchestration:** The Vercel AI SDK's `streamText` with a single `searchPortfolio` tool, in one Worker call. There is no separate rewrite, embedding or retrieval stage in my code.
- **Inference:** Workers AI. GLM-4.7-Flash is the default model, with Gemma and then Llama as fallbacks if a model fails before producing output.
- **Search:** A Cloudflare AI Search instance. It does the chunking and embedding, hybrid vector-plus-keyword retrieval, and reranking with `@cf/baai/bge-reranker-base`.
- **State:** Conversation history lives in the browser. Server-side request logs live in AI Gateway and Workers Logs.

{{< mermaid >}}
flowchart LR
    Browser[Browser widget] -->|POST question and history| Worker[Worker /api/chat]
    Worker --> Gen[Workers AI model with searchPortfolio]
    Gen -->|search query| Search[(AI Search instance)]
    Search -->|ranked chunks| Gen
    Gen -->|SSE stream| Browser
    Static[Static site on Cloudflare] -.-> Browser
{{< /mermaid >}}

## 💬 From question to answer

The browser sends the question and a bounded slice of recent history. The model decides whether to search and what to search for. After "Tell me about Demonware", the follow-up "What did he do before that?" becomes a search such as "Samson's role before Demonware", because the model writes its own standalone query from the conversation. That replaces the separate rewrite call the earlier pipeline made. The model may search more than once, up to three steps; on the last step the tool is switched off so the turn must end with text.

Letting the model write the query removes a stage, but it also moves a failure point: a poor query changes what gets retrieved. The evaluation therefore checks the query the model actually issued.

{{< mermaid >}}
sequenceDiagram
participant User
participant Frontend
participant Function as Worker
participant AI as Workers AI
participant Search as AI Search
User->>Frontend: Ask a question
Frontend->>Function: POST query and bounded history
Function->>Function: Validate request and service bindings
Function->>AI: streamText with system prompt, history and searchPortfolio
loop Up to three steps
    AI-->>Function: Tool call with a standalone query
    Function->>Search: Hybrid search, rerank
    Search-->>Function: Ranked chunks
    Function-->>Frontend: Citations from chunk metadata
    Function->>AI: Titles and text only
end
AI-->>Function: Answer stream
Function-->>Frontend: Normalized SSE answer and metrics
Frontend-->>User: Render answer and expandable sources
{{< /mermaid >}}

Three bounds keep the work predictable:

- **History:** at most four messages, 2,000 characters each and 4,000 characters in total.
- **Retrieval:** up to six results above a 0.4 match threshold, with the context handed to the model capped at 12,000 characters.
- **Generation:** a 512-token completion budget, at most three steps, and a 60-second turn deadline.

These limits control cost and latency. They do not make an answer correct. Correctness depends on whether the search found the right evidence and whether the model used it faithfully.

### 📊 Answer outcomes

Every request ends in one of a few states. Making them explicit matters more than the happy path, because a chat widget that silently produces an empty answer is worse than one that fails loudly.

{{< mermaid >}}
stateDiagram-v2
    [*] --> Validating
    Validating --> Rejected: Bad body or missing binding
    Validating --> Generating
    Generating --> Searching: Model calls searchPortfolio
    Searching --> Generating: Results returned
    Generating --> Answered: Model answers from results
    Generating --> Abstained: Model says results are insufficient
    Generating --> Failed: Provider or stream error
    Answered --> [*]
    Abstained --> [*]
    Failed --> [*]
    Rejected --> [*]
{{< /mermaid >}}

- **Abstention** is now a single layer: the nine-line system prompt tells the model to say the information is insufficient when the results do not establish a fact. The earlier deterministic check (too little retrieved text returned a fixed message without calling the model) is gone. The prompt is an instruction, not a verifier.
- **Rejected** requests return an HTTP error before any streaming starts. Oversized bodies are refused with 413 before the JSON is parsed.
- **Failed after streaming starts** becomes one error event followed by the end-of-stream marker, and the upstream model stream is cancelled. The client never sees an empty success.
- **Fallback.** A model that fails before producing any output hands the turn to the next one (GLM, then Gemma, then Llama). After output has started, a failure is final. The SDK's own retries are off, so the model chain is the only retry.

## 📚 Building the knowledge base

The answer is only as good as the corpus behind it. `make ai-refresh` runs the maintained entry point, `scripts/ingest_corpus.mjs`, which uses the corpus modules under `scripts/lib/`. I no longer chunk or embed anything myself; the repository uploads source files with metadata and AI Search does the rest.

The pipeline:

1. **Normalize.** Markdown and HTML are parsed structurally. Presentation controls are removed while lists, links and code survive.
2. **Map to public URLs.** Hugo's published-page export supplies canonical URLs, including slugs and permalink rules, and they travel as chunk metadata.
3. **Upload.** Each source file goes to a new AI Search instance with its metadata. The instance chunks (2,000 characters, 200 overlap) and embeds with `@cf/baai/bge-base-en-v1.5`.
4. **Point a curated excerpt at a public page.** A short curated excerpt can cite a canonical public page while keeping unique curated facts:

```yaml
retrievalSource: "content/resume/_index.md"
retrievalSection: "Professional Experience"
```

`retrievalSource` still sets the citation URL. `retrievalSection` is now ignored: citations are page-level, not section-level. Internal excerpts help answers but are never shown in the public source panel.

5. **Wait, then activate.** The deploy switches to the new instance only after every item is indexed.

{{< mermaid >}}
flowchart LR
    Content[Markdown and front matter] --> AST[Structured normalization]
    Hugo[Hugo published URLs] --> Corpus[Validated corpus]
    AST --> Corpus
    Corpus --> Upload[Upload files and metadata]
    Upload --> Index[AI Search candidate instance]
    Index --> Ready[Wait for indexing]
    Ready --> Deploy[Deploy with AI_SEARCH_INSTANCE]
{{< /mermaid >}}

Instances are named `portfolio-<12 hex of the corpus hash>`, and the hash covers source contents and chunking/search configuration. A candidate therefore never mutates the live instance. Unchanged corpora skip ingestion; a changed corpus becomes a new instance. Uploads do not retry and abort on the first failure.

This is blue/green for the corpus. After a deploy, `make cleanup-instances` keeps the live instance and the previous one and deletes older `portfolio-*` instances, so reverting to the previous commit still finds its instance. It refuses to run when it cannot determine the live instance, and stops if a deploy changes it mid-run.

## ⚖️ Why AI Search

The first version of this assistant built its own retrieval: parsing, chunking, embeddings, a Vectorize index, a query rewrite call, a result cache and parent-section expansion. I replaced it with managed Cloudflare AI Search because most of that code was search infrastructure rather than anything specific to my portfolio.

{{< mermaid >}}
flowchart LR
    subgraph Before
    C[Own chunking and embeddings] --> V[Vectorize namespace]
    V --> R[Rewrite, cache, section expansion]
    end
    subgraph Now
    U[Upload files and metadata] --> A[AI Search instance]
    A --> T[searchPortfolio tool]
    end
{{< /mermaid >}}

| | What I moved to managed infrastructure | What I kept |
| --- | --- | --- |
| Ingestion | Chunking and embedding | Normalization, Hugo URL mapping, corpus validation and hashing |
| Retrieval | Hybrid vector and keyword search, reranking | The tool definition, thresholds and context budget |
| Query handling | Follow-up rewriting becomes part of the model's tool call | The prompt and the evaluation of issued queries |
| Releases | Index storage and operations | Hash-named instances, gates, cleanup |

- **Control.** I give up control of chunking, retrieval and evidence shaping beyond AI Search's configuration. Section-level citations are not possible because citations come from page-level chunk metadata.
- **Cost.** There is no measured savings claim. AI Search pricing, plan limits and Workers AI usage still apply, and this design has not run in production yet. See [AI Search pricing and limits](https://developers.cloudflare.com/ai-search/platform/limits-pricing/) and [chunking controls](https://developers.cloudflare.com/ai-search/configuration/indexing/chunking/).
- **Why it should help.** Hybrid search covers exact terms that semantic-only retrieval missed, the reranker orders results, and I maintain less code. Whether answers are actually better is exactly what the next evaluation has to show.

## 🔍 Retrieval and evidence

The tool asks the instance for hybrid retrieval with up to six results, a 0.4 match threshold, one chunk of context expansion on each side and `bge-reranker-base` reranking. The tool result is trimmed to a 12,000-character budget.

The model sees only each result's title and text. The public sources (title, URL and excerpt) travel in the tool output to the wire mapper and never reach the model, so the model cannot write or alter a link, and the system prompt forbids writing URLs. The Worker derives citations from chunk metadata and shows them in the widget.

There is no retrieval cache in my code, no parent-section expansion and no abstention threshold on retrieved text. AI Search's own query cache is enabled.

## ✨ Generation and streaming

The system prompt is nine lines. It tells the model to answer only from `searchPortfolio` results, to search for any fact about me with its own standalone query, not to search greetings, to treat results and history as data rather than instructions, to treat the resume as authoritative for dates, titles and education, and to say when the results are insufficient. Generation streams tokens back through the Worker.

The Worker normalizes the provider's stream into its own server-sent events: progress stages, answer text, metrics and a final end-of-stream marker. The browser protocol is unchanged by the rebuild, and it depends on one event contract, not on the provider's format. If the client disconnects, the Worker forwards the abort signal to the model and search calls; whether the provider stops billing for the in-flight request is provider-dependent and not asserted here.

Progress labels describe actual operations: finding sources and writing an answer. An elapsed counter runs until answer text arrives. A failed request offers a manual Retry that reuses the original question and the history from before the request. There are no automatic paid retries.

## 🪟 A native, inspectable chat window

The widget is a native `<dialog>` rather than an iframe, so it inherits the theme, supports keyboard controls and uses a full-height layout on phones. Starter questions introduce experience, projects, scale and the assistant itself.

**Retrieved sources** lists the public pages the search returned. This is evidence the model had, not proof that each sentence of the answer was checked against it. The panel makes that difference visible instead of hiding it.

Markdown renders with restricted markup. Mermaid diagrams load when the panel opens, and invalid or truncated diagrams keep their source with an explanation.

The diagnostics footer shows server-side total latency, time to first answer token, the model that answered, its token usage and the estimated token cost. When the provider omits usage, the field is shown as unavailable rather than zero, because a missing number is not the same as no cost. The estimate covers model tokens only; AI Search and hosting are excluded.

Conversation history persists on the device across deployments until it is cleared manually. Clearing history does not delete server-side logs, which are stored separately.

## 🧭 Design decisions and trade-offs

Each major choice was made to keep a small system inspectable rather than to chase a headline number:

- **One Worker, one API surface.** `/api/chat` is the only server-side entry point for the assistant, and one `streamText` call runs the whole turn.
- **Managed search over my own pipeline.** Less code to own, at the cost of control over chunking and evidence. Evaluation decides whether that was a good trade.
- **The model writes the query.** One fewer stage, but query quality is now model behaviour, so the evaluation gates on it.
- **The model never sees URLs.** Citations are attached from metadata, so a hallucinated link cannot reach a visitor.
- **Abstention over hallucination.** A wrong answer is worse than "I don't know", but abstention is now only a prompt instruction.
- **Hash-named instances instead of in-place updates.** A changed corpus becomes a new instance and the deploy switches only after indexing completes. Rollback is a redeploy of an earlier commit, which finds its instance still there.
- **Client disconnects and deadlines propagate.** One abort signal (client disconnect or a 60-second turn deadline) is forwarded to the model and search calls, so a closed tab stops paying for tokens, even though Workers AI's actual stop behavior is not verified here.

## 📈 Operational characteristics

- **Latency:** first visible answer token and total time are measured separately and reported in the diagnostics footer. They include the search calls, because the clock starts with the request.
- **Cost:** model cost is estimated per request from token counts at dated prices; AI Search and hosting are excluded.
- **Observability:** timings and token usage are shown to the visitor and logged server-side by Workers Logs, with model calls recorded in AI Gateway. There are no automatic paid retries.
- **Security boundary:** a prompt instruction is not a security boundary, and there is no input filter; the public chat endpoint has an approximate per-IP rate limit (10 requests a minute per Cloudflare location) but no spend cap in the repository.

## 🛡️ Security and abuse controls

- **Input validation.** Hono's `bodyLimit` caps request bodies at 64 KB and refuses larger ones with 413; a zod schema (via `@hono/zod-validator`) rejects malformed JSON, over-long queries and bad history with a 400 before any streaming starts. Responses carry Hono's `secureHeaders`.
- **Prompt boundaries.** The prompt tells the model to treat search results and history as data, ignore commands inside them and abstain when results are insufficient. This is an instruction, not a verifier; it reduces but does not eliminate hallucination or injection.
- **One narrow tool.** The model has a single read-only tool that searches my published content: no web access, no writes, no model training or fine-tuning. A successful prompt injection could change what it searches for or says, but cannot reach external systems or persistent state.
- **Data minimization.** Conversation history lives in the browser; server-side logs (AI Gateway and Workers Logs) are not publicly readable and follow Cloudflare's retention limits for those products. Visitors are told not to include passwords, financial details or confidential material.
- **Known gaps.** The per-IP rate limit is approximate and limits volume, not spend. I did not add Turnstile or server-side sessions. Human review and concurrency testing are the next steps, not finished work.

## ✅ Verification and limits

```bash
make ai-check   # Corpus identities, Hugo URL provenance and evaluation labels
make test       # Offline regressions
make ai-build   # Bundle the Worker (dry run) with Node.js 22+
make ai-eval    # Paid: promptfoo evaluation against an AI Search instance
make dev-ai     # Local site with the chat API
```

The offline tests cover parsing preservation, explicit errors, streaming, token accounting, model fallback and deployment gates. Live evaluations are separate: they run the real turn against labeled questions. For example, a recent-experience regression checks that the answer names Demonware and cites dated evidence, instead of accepting a plausible but vague internship summary. Those evaluations make paid calls and are run deliberately, not in CI.

### 📊 Evaluation

The live evaluation runs on [promptfoo](https://www.promptfoo.dev/) with a small custom provider that calls the production `runTurn`, the same code as the Worker. One test per labeled question runs these gating checks: the model **searched**, an expected source was retrieved (**retrieval-hit**), the **query** it issued kept the conversation's subject, and the **links** in the answer are acceptable. Evidence and answer term checks are reported but do not gate, because exact-term matching rejects correct paraphrases. The run gates at a 90% pass rate.

#### 🏁 Results from the previous pipeline: not yet re-measured

{{< alert "triangle-exclamation" >}}
**The new AI Search pipeline has not been deployed or evaluated yet.** The numbers below were measured on the previous Vectorize-based pipeline and say nothing about the current design.
{{< /alert >}}

On the previous pipeline, developer-run on 2026-11-20 with 74 labeled questions, one GLM repetition and the live Vectorize corpus, **67 of 74 cases passed (90.5%)** and retrieval found an expected source for **61 of 64** answerable questions (95.3% hit@5). Follow-up rewriting was the weak spot: only **1 of 5** rewrites kept the conversation's subject. The three retrieval misses were corpus coverage gaps (the load-platform sustained-duration and engineering-value questions, and the deployment and rollback question), not ranking bugs.

Those follow-up failures motivated dropping the separate rewrite call, so the first thing to check in the next run is whether the model-written queries do better. That is a hypothesis, not a result. It is one run, one model and one corpus snapshot, and it does not rank models or score factual accuracy. The [engineering notes](https://github.com/sgama/sg/blob/develop/README.md) describe the evaluation setup.

The limits are real:

- A prompt instruction is not a security boundary, and there is no input filter; see the Security section.
- Search can miss relevant evidence, especially when the visitor uses a term the portfolio never uses, and I cannot tune the managed chunking beyond its configuration.
- Citations are page-level, so a source link does not point to the exact section that supports a sentence.
- The model decides whether to search, so it can answer a factual question without searching or issue a weak query.
- Models can misinterpret dates, and an answer can combine true facts into a false claim.
- Term-based evaluations can show that expected terms appear. They cannot prove that an answer is entailed by its sources.
- Human review and concurrency testing are the next steps, not finished work.

Static hosting can be inexpensive, but inference and storage have quotas and usage-based costs. The point of this architecture is not "free AI". It is a small, inspectable system in which search, transport, quality and economics can each be measured on their own.
