---
title: "My Over-Engineered Serverless & Self-Hosted Stack"
date: 2026-01-26
lastmod: 2026-10-25
slug: "website-stack"
description: "A comprehensive look at how this static site is built, deployed, and monitored using Hugo, GitHub Actions, a Cloudflare Worker with static assets, Workers AI, Vectorize, and Tunnels."
summary: "Why have a simple website when you can have a complex one? A deep dive into the CI/CD pipeline, serverless AI integration, and zero-trust self-hosted analytics stack that powers samsongama.com."
tags: ["infrastructure", "cloudflare", "github-actions", "devops", "self-hosted", "hugo"]
showDate: true
series: ["Cloudflare Developments"]
---

![Featured image](featured.webp)

About 10 years ago, hosting a website meant paying \$5/month for a VPS, configuring Nginx, and manually FTPing files. Today, we have the "Modern Web"—a beautiful, chaotic mix of static site generators, edge computing, vector databases, and zero-trust tunnels.

This website is a static site (Hugo), but it's wrapped in layers of automation and serverless features that make it feel alive. Here is an architectural overview of how `samsongama.com` is built, deployed, and monitored, updated for the current implementation.

## 🏗️ The High-Level Architecture

At its core, the site lives on the **Cloudflare Edge**. Content is distributed globally, while dynamic features (like the AI Chat) run on serverless workers. Analytics are self-hosted on my home lab but exposed securely to the internet.

{{< mermaid >}}
graph TD
User((Visitor))

subgraph Cloudflare["☁️ Cloudflare Edge"]
    DNS[DNS & DDoS Protection]
    CDN[CDN Cache]
    WAF[Web App Firewall]
    Assets[Static Assets]
    Functions[Worker /api/*]
    Workers[Cloudflare Workers AI]
    Vectorize[Vectorize]
    KV[KV Chat Logs]
    Tunnel[Cloudflare Tunnel]
end

subgraph Github["🐙 GitHub"]
    Repo[Source Code]
    Actions[GitHub Actions CI/CD]
end

subgraph HomeLab["🏠 Home Lab"]
    Cloudflared[cloudflared daemon]
    Analytics[Analytics Container]
end

User -->|HTTPS| DNS
DNS --> WAF
WAF --> CDN

CDN -->|Static Content| Assets
CDN -->|Dynamic API| Functions
Functions --> Workers
Functions --> Vectorize
Functions --> KV
CDN -->|ping.samsongama.com| Tunnel

Tunnel <-->|Secure Connection| Cloudflared
Cloudflared <--> Analytics

Repo -->|Push| Actions
Actions -->|Deploy| Assets
Actions -->|Deploy| Functions
{{< /mermaid >}}

---

## 1. Development & Quality Assurance

Quality starts before any deployment. Quality checks run through **Make targets** on demand and in CI:

1. **Linting**: `make lint` checks all JavaScript (ESLint); `make format-check` checks YAML and CSS formatting; workflow linting uses `actionlint`.
2. **Content Checks**: `make audit-content` validates front matter coverage. Production rendering is checked separately in CI.
3. **Tests**: `make test` runs the complete offline Node.js unit suite.

```bash
# The offline validation entry point
make ci-check
```

---

## 2. CI/CD: GitHub Actions

Production deployment is handled by a **GitHub Actions** workflow on pushes to `develop`. Pull requests targeting `develop` run validation without deploying or making paid embedding calls. Make targets also support deliberate local builds and deployments.

### The Pipeline Steps

1. **Checkout**: Pulls the latest code.
2. **Setup Node & Hugo**: Installs dependencies.
3. **Validate & Build**: Runs `make ci-check`: workflow and JavaScript linting, offline tests with coverage, corpus checks, Worker bundling check, type checking, PostCSS/PurgeCSS, the production Hugo build, and generated-layout tests.
4. **Detect Changes**: Runs `make deploy-needed`, which compares the commit the live Worker was built from (recorded in its `DEPLOY_COMMIT` variable) with the current one. If no file that can change the site differs, the refresh and deploy are skipped; any doubt deploys.
5. **Refresh Corpus**: Runs `make ai-refresh` to skip an unchanged corpus or embed a changed one into a versioned Vectorize namespace. It waits for indexing before preparing the matching deployment configuration; failure blocks deployment.
6. **Deploy**: Runs `make deploy-built`, one `wrangler deploy` that uploads the validated `public/` output as static assets and the Worker together, as a single live version.
7. **Prune**: Runs `make cleanup-vectors`, deleting the vectors of older versioned corpora. It keeps the namespace the live Worker uses and the one before it, so a rollback can reuse recent vectors. Rolling back means redeploying an earlier commit.

For example, a CSS-only change can reuse the existing corpus. A published content edit changes the corpus hash and requires new embeddings before the deployment proceeds. Three caches (tools, Hugo modules, generated resources) and parallel Make jobs keep a cached run to about a minute.

{{< mermaid >}}
sequenceDiagram
participant Dev as Developer
participant GH as GitHub Actions
participant Build as Build Container
participant CF as Cloudflare Worker
participant Vec as Vectorize DB
participant AI as Workers AI

Dev->>GH: git push develop
GH->>Build: Spin up Runner
Build->>Build: Install Hugo & Node
Build->>Build: make ci-check

rect rgb(20, 20, 20)
    Note over Build, Vec: Refresh changed corpus; skip unchanged corpus
    Build->>Build: Parse content and compute corpus hash
    opt Corpus changed
        Build->>AI: Generate embeddings
        AI-->>Build: Return vectors
        Build->>Vec: Upsert versioned records
        Build->>Vec: Wait for indexing completion
    end
end

Build->>CF: Deploy assets, Worker and matching namespace
CF-->>Dev: Deployment Success 🚀
Build->>Vec: Delete older corpora (keep live and previous)
{{< /mermaid >}}

---

## 3. The Edge: Cloudflare Ecosystem

Once deployed, the site lives on Cloudflare's network. Static hosting, edge caching and managed TLS reduce the infrastructure I operate; dynamic AI and storage still have usage limits and potential charges.

### DNS & CDN

Cloudflare proxies all traffic. This means:

- **SSL is automatic:** I don't manage certificates; Cloudflare handles edge encryption.
- **Caching:** Static assets (images, CSS, JS) are cached in data centers close to the user, reducing latency.
- **Build-Time Optimization:** Hugo minifies output, while PostCSS/PurgeCSS builds the production stylesheet. This does not depend on Cloudflare auto-minification.

### Workers & Vectorize (The "Smart" Layer)

This is where the [AI Assistant](/posts/2026-01-25-ai-chat/) lives. A **Cloudflare Worker** handles `/api/chat` and `/api/logs`; Cloudflare serves the static site directly and runs the Worker first only for `/api/*`. **Workers AI** provides embedding and answer models, and **Vectorize** holds the searchable corpus. I do not operate a dedicated Python inference server or train model weights.

- **Conversation:** The browser sends bounded recent history. A follow-up such as "What did he do before that?" is rewritten into a standalone search question before embedding.
- **Retrieval:** Vectorize returns three semantic matches. Matching child excerpts expand into bounded source sections, with generic canonical-source links keeping curated summaries tied to authoritative public content.
- **Generation:** The answer model receives retrieved text, history and the original question, then streams its response. Insufficient context produces an abstention; service failures produce explicit errors.
- **Transparency:** The widget shows actual progress stages, public retrieved excerpts and expandable timing/token/cost diagnostics. Source retrieval does not independently verify an answer.
- **State:** Conversation history stays in browser storage across deployments until manually cleared. When configured, KV separately records questions, responses and answer-model usage.

For example, an internship excerpt can lead retrieval to the full newest-first employment section, rather than presenting that historical fragment as recent experience. This reduces missing context; it does not guarantee that a model interprets every date correctly.

Edge execution reduces the need to manage application servers, but model inference and retrieval still dominate some responses. I measure latency rather than assuming every answer is instant.

### How the RAG chatbot works

Retrieval-augmented generation (RAG) means the model answers from text fetched at question time, not only from what it learned in training. This chat answers from a curated, internal corpus of summaries and source sections. Nothing in that corpus is published as its own page.

#### Why RAG at all, when the corpus is small

The whole corpus is about 38 KB of Markdown, roughly 10,000 tokens. That fits in a modern context window, so "put everything in the prompt" is a serious alternative. I kept retrieval for three reasons:

- **Bounded cost per question.** Each answer sends at most 12,000 characters of context (`maxContextChars`), however large the corpus grows.
- **Traceable evidence.** The sources the visitor sees are the excerpts that were actually sent to the model.
- **Separable stages.** Chunking, embedding, indexing, retrieval and generation are distinct steps. A new model or a larger corpus changes one stage, not the whole chat.

I have not benchmarked long-context prompting against this pipeline, so I cannot claim retrieval is more accurate. It is a cost and control decision.

#### Vocabulary used below

| Term         | Meaning in this site                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Section      | A heading-delimited span of a source file. Whole sections are stored up to 6,000 characters.                                  |
| Chunk        | A child piece of a section, targeting 2,000 characters with 200 characters of overlap. Only chunks are embedded and searched. |
| Embedding    | A 768-number vector from `@cf/baai/bge-base-en-v1.5`. Texts with similar meaning get nearby vectors.                          |
| Vector index | Vectorize index `portfolio-index`. Given a query vector, it returns the nearest stored vectors.                               |
| Namespace    | A partition inside the index, named from the corpus hash. Every query is filtered to one namespace.                           |
| Top-k        | How many matches come back. Here it is 3.                                                                                     |
| Grounding    | The answer must come from retrieved text. The system prompt says so.                                                          |
| Abstention   | Saying the context is insufficient instead of guessing.                                                                       |

#### Ingestion: from Markdown to a versioned index

Ingestion runs in CI and only when the corpus changes. A content edit that does not change the corpus hash costs nothing.

{{< mermaid >}}
flowchart TD
Src["Curated corpus, internal Markdown"] --> Sections["Split by heading into sections, up to 6,000 chars"]
Sections --> Chunks["Child chunks, 2,000 chars with 200 overlap"]
Sections --> Links["Canonical links to public pages"]
Chunks --> Ids["Deterministic IDs: hash of namespace, source and index"]
Ids --> Hash["Corpus hash picks the namespace"]
Links --> Hash
Hash -->|"Namespace already live or previous"| Skip["Skip: nothing to embed"]
Hash -->|"New namespace"| Embed["Embed every record, bge-base, 768 dims"]
Embed --> Upsert["Upsert in batches into the new namespace"]
Upsert --> Wait["Wait until Vectorize reports the mutation processed"]
Wait --> Config["Write AI_CORPUS_NAMESPACE and AI_PREVIOUS_CORPUS_NAMESPACE"]
{{< /mermaid >}}

**Chunking is two-level.** Retrieval needs a small unit to match precisely, but the model needs enough surrounding text to avoid misreading a fragment. So each section is stored whole, and its child chunks point back to it with `parentIndex`. A match on a child expands to the parent section before generation.

{{< mermaid >}}
flowchart LR
Sec["Section record: full text up to 6,000 chars"]
C1["Child chunk 0: 2,000 chars"]
C2["Child chunk 1: 2,000 chars, overlaps 200"]
C3["Child chunk 2: remainder"]
Canon["Canonical record: points to a public page"]
C1 -->|"parentIndex"| Sec
C2 -->|"parentIndex"| Sec
C3 -->|"parentIndex"| Sec
Canon -->|"canonicalIndex"| Sec
{{< /mermaid >}}

Chunk size is a trade-off:

- **Smaller chunks** match more precisely, but a fragment can split a date range or a list, so its meaning changes.
- **Larger chunks** keep context together, but a long chunk's embedding averages over more topics and each match costs more tokens.
- **Overlap** (200 characters) keeps a sentence cut at a boundary available in both neighbours.

I chose these sizes by reasoning, not by sweeping them against the evaluation set. That sweep is the obvious next experiment.

Each record carries metadata: source file, title, section heading, public URL, record type, and the parent or canonical indices. Records are validated against a schema (version 2) before upload, and tampered metadata, namespaces or chunk IDs fail the integrity check.

**Namespaces give versioning without re-indexing in place.** The namespace is `corpus-` plus the first 56 hex characters of the corpus hash. A content change produces a new namespace, so old and new vectors never mix. The chunk ID is a hash of namespace, source and index, so an interrupted upload can be retried idempotently. The Worker reads one namespace name from its configuration. CI switches that name only after Vectorize reports the upload processed, so the live site never points at a half-indexed namespace.

**The embedding model fixes the index dimension.** A Vectorize index has a fixed vector size, here 768. Changing the embedding model means re-embedding every record, and a new dimension means a new index. Re-embedding this corpus costs well under a cent (estimate), so the real cost of a model change is the evaluation, not the embeddings.

#### Retrieval: finding evidence for a question

{{< mermaid >}}
sequenceDiagram
participant B as Browser
participant W as Worker /api/chat
participant AI as Workers AI
participant V as Vectorize

B->>W: Question and bounded history
alt Follow-up question with history
W->>AI: Rewrite into a standalone query, 96 output tokens max
AI-->>W: Standalone query
end
W->>W: Check cache by namespace and query
alt Cache miss
W->>AI: Embed the standalone query
W->>V: Top 3 matches, filtered to the live namespace
V-->>W: Child chunk matches
end
W->>W: Expand children to parent sections, add canonical links
{{< /mermaid >}}

1. **History is bounded.** The browser sends at most 4 earlier messages, 2,000 characters each and 4,000 characters in total. Older turns are dropped on the client.
2. **Follow-ups are rewritten.** A question such as "What did he do before that?" means nothing to a vector index. The contextualization model turns it into a standalone query. Its input is capped at 500 characters, and it stops after 96 output tokens. The first turn skips this step.
3. **The query is embedded** with the same model used for the corpus. Using different models for the two sides makes the scores meaningless.
4. **Search is semantic only.** Vectorize returns the 3 nearest child chunks in the live namespace. I do not combine vector and keyword (BM25) search, and I do not rerank. At about 15 source files, the evaluation has not yet shown a need for either.
5. **Results are cached** by namespace and query, so a repeated question skips the paid embedding and search calls. Namespace in the key means a new corpus cannot receive stale answers from an old one.

#### Context assembly: what the model actually reads

{{< mermaid >}}
flowchart LR
M["Top 3 child matches"] --> P{"Has a parent section?"}
P -->|"yes"| S["Parent section, up to 6,000 chars"]
P -->|"no"| T["The matched record"]
S --> D["Deduplicate by section"]
T --> D
D --> C["Add canonical links to public pages"]
C --> B{"Within 12,000 characters?"}
B -->|"yes"| Prompt["Prompt: rules, context, history, question"]
B -->|"no"| Trim["Trim to the budget"]
Trim --> Prompt
{{< /mermaid >}}

Expansion trades precision for context. A three-chunk match might bring back three full sections, so the budget matters. A fragment can also mislead when read alone: an internship excerpt can lead retrieval to the whole newest-first employment section, which is what prevents presenting an old fragment as recent experience. Expansion reduces missing context; it does not guarantee the model reads dates correctly.

#### Generation: constrained answering and streaming

The model receives three things: a system prompt, a context block labelled "Retrieved Context", the bounded history and the question. The system prompt tells it to answer from the excerpts and, when they do not establish a fact, to say the available context is insufficient. Completions are capped at 512 tokens.

{{< mermaid >}}
stateDiagram-v2
[_] --> Retrieved
Retrieved --> Abstained: Context under 20 characters, no model call
Retrieved --> Generating: Context present
Generating --> Answered: Model answers from excerpts
Generating --> Abstained: Model reports context is insufficient
Retrieved --> Failed: Retrieval or model error
Generating --> Failed: Model error after streaming
Answered --> [_]
Abstained --> [_]
Failed --> [_]
{{< /mermaid >}}

- **Abstention has two layers.** A deterministic check abandons the request before any model call when retrieved context is under 20 characters. Otherwise the model abstains only if the prompt-driven answer says the excerpts are insufficient. Nothing verifies that each claim in a generated answer is supported; a groundedness check would be a second model call with its own cost and errors, which I have not added.
- **Streaming is server-sent events.** The Worker sends progress stages, the sources, then tokens. A stream error produces one error frame and then `[DONE]`. If the stream fails, the upstream reader is cancelled.
- **Cancellation is partly unverified.** The abort signal is passed to the model call. Whether Workers AI stops inference immediately on abort is not documented in the repo, and I have not measured it.
- **The chat has no tools.** The Worker only retrieves and generates text. A user who tries prompt injection can change the tone of an answer, but cannot make the chat read or write anything else.

#### Evaluation: what is measured, and what is not

The evaluation harness lives in `scripts/lib/evaluation`: fixtures, runs, scoring and reports. Two Make targets use it: `make ai-retrieval-eval` checks retrieval only, and `make ai-compare-rag` runs the end-to-end chat, which makes paid calls.

{{< mermaid >}}
flowchart LR
Fix["Fixtures: questions and expected terms"] --> Ret["Retrieval run"]
Ret --> Ev["Evidence check: expected terms present in context"]
Fix --> Ans["End-to-end run"]
Ans --> Sc["Answer check: required terms present, forbidden terms absent"]
Ev --> Rep["Report"]
Sc --> Rep
{{< /mermaid >}}

The scoring is deliberately simple and reproducible, and it has clear limits:

- A keyword check misses paraphrases, so a correct answer phrased differently fails.
- It can also pass a wrong answer that happens to contain the expected terms.
- It measures the fixtures I wrote, which share my assumptions about what matters.

The post does not quote results. Benchmark numbers belong in the evaluation reports, with the model versions and dates that produced them.

#### Questions I would expect in an interview

- **Why semantic search only?** The corpus is small and the evaluation has not shown a keyword or reranking need. Adding either is a measured change, not a default.
- **How do you handle stale vectors?** Each content version gets its own namespace. Cleanup keeps the live and previous namespaces and deletes older vectors. It does not wait for Vectorize to finish deleting, because the Worker reads only its own namespace.
- **What happens when you change the embedding model?** Every record is re-embedded into a new namespace, with new dimensions if the size changes. Cached retrieval results from the old namespace are never served.
- **Why top 3?** It fits the context budget and keeps cost predictable. I have not swept it against recall.
- **What is the biggest weakness?** The evaluation is term-based and small. Abstention is a deterministic length check plus a prompt instruction, not a verifier.

#### Why not Cloudflare AI Search

Cloudflare AI Search is a managed RAG product: upload documents, and it handles chunking, embeddings, storage, search and generation. For a site without a team, that is attractive. I evaluated it and kept my own pipeline, mainly for cost and control.

{{< mermaid >}}
flowchart LR
subgraph Mine["This pipeline: I own each stage"]
direction LR
A1["Section and chunk rules"] --> A2["Deterministic IDs and validation"] --> A3["Namespace per version"] --> A4["Vectorize and prompt budget"]
end
subgraph Managed["AI Search: managed stages"]
direction LR
B1["Upload documents"] --> B2["Managed chunking and indexing"] --> B3["Managed search and generation"]
end
{{< /mermaid >}}

Cost estimates at an assumed 1,000 questions a day (about 30,000 a month), using the published rates:

| Item              | This pipeline (Vectorize)                                                                                                   | AI Search                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Retrieval         | About \$0 extra: Vectorize meters queried dimensions, not queries, and this volume fits the included Workers Paid allowance | About \$22 a month: roughly 29,000 semantic queries beyond the 1,000 included, at \$0.75 per 1,000 |
| Embeddings        | Workers AI, well under \$0.01 per full corpus re-embed (estimate)                                                           | Included in AI Search                                                                              |
| Answer generation | Workers AI, about \$8–11 a month at this volume                                                                             | Same model cost, billed separately                                                                 |
| Total (estimate)  | About \$10 a month                                                                                                          | About \$30–35 a month                                                                              |

Assumptions behind these numbers:

- Retrieval is billed as semantic queries. If AI Search also bills hybrid search as full-text queries, the total rises. I have not verified that.
- The 1,000 included semantic queries would also be used by my evaluation runs, which make paid calls.
- Prices and included allowances may change. AI Search billing starts on November 1, 2026.

The cost is not the only reason. AI Search chunks documents itself, so I would give up:

- Section structure: parent and child excerpts, and canonical links back to public pages.
- Deterministic chunk IDs, which let me validate each corpus before it goes live.
- Control over the metadata schema. AI Search allows five custom metadata fields per instance and 10 KiB per vector.
- Control over the prompt and the context budget.

The trade-off is that I own ingestion, validation, namespace cleanup, evaluation and the failure modes described above. That ownership is the work the cost comparison is paying for.

---

## 4. Observability: Self-Hosted Analytics via Tunnels

I self-host **Umami**, served at `ping.samsongama.com`, rather than relying on a third-party analytics dashboard. Cloudflare still proxies the traffic, so self-hosting is not a claim that no external infrastructure handles the data. How do I expose the service without forwarding an inbound port on my home router?

**Cloudflare Tunnels (cloudflared)**.

### How it works

Instead of forwarding port `443` on my home router, I run a lightweight daemon called `cloudflared`.

1. `cloudflared` creates an outbound-only connection to Cloudflare's edge.
2. A public hostname, `ping.samsongama.com`, routes analytics traffic through the tunnel.
3. Cloudflare Access can protect private dashboard routes, while the tracking script and collection endpoints must remain accessible to visitors.

{{< mermaid >}}
flowchart LR
Visitor["Visitor Browser"]
CF["Cloudflare Edge"]
Router["Home Router (No Open Ports)"]
Server["Home Server"]
Container["Analytics Docker"]

Visitor -->|"HTTPS"| CF
CF <-->|"Encrypted Tunnel"| Server

subgraph HomeNetwork["Home Network"]
    Router
    Server -->|"Running cloudflared"| Container
end

style Router stroke:#f00,stroke-width:2px,stroke-dasharray:5
{{< /mermaid >}}

### Benefits

- **No Port Forwarding:** The analytics service does not require an inbound router port or a public DNS record pointing directly to my home IP.

- **Edge Protection:** Public requests pass through Cloudflare; this does not make the origin or application immune to abuse.
- **Access Control:** I can put the dashboard usage behind **Cloudflare Access** (OAuth / Email OTP), so only I can view the data, while the tracking script remains public.

## Conclusion

This stack represents the sweet spot of modern web development: **Static reliability** mixed with **serverless power**, all glue-coded together with **CI/CD** and secured by **Zero Trust** networking.

Static delivery is inexpensive, but this is not an infinitely scalable or universally free stack. Workers AI, Vectorize and KV have quotas and usage-based costs, while self-hosting adds hardware, power and maintenance. The chat's displayed cost estimates cover answer and rewrite tokens, not the entire infrastructure bill.

## What's Next

- **Retrieval quality:** Expand regression questions and human review, especially for ambiguous follow-ups and unsupported claims.
- **Runtime controls:** Add request deadlines and rate limits, and measure behavior under concurrent traffic.
- **Ingestion efficiency:** Reuse unchanged document embeddings across corpus versions instead of regenerating the whole changed corpus.
