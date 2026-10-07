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

### AI Infrastructure and Model Evaluation

AI configuration is shared by the runtime and evaluation tools in
[`functions/_lib/config.js`](functions/_lib/config.js). Model aliases are
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
CI does rebuild embeddings automatically for every commit pushed to `develop`.

The labeled fixture in [`tests/fixtures/ai-eval.json`](tests/fixtures/ai-eval.json)
checks expected source paths rather than keyword-only retrieval hits. Its answer
checks are deterministic term assertions, not a substitute for human groundedness
review. Extend the small starter set with paraphrases, project-specific facts,
negative questions, and production failures before trusting a model ranking.

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
resume build step. Only retrieved chunks reach the generation prompt, so retrieval
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

Every push to `develop` runs unit tests, `make ai-refresh`, then builds/deploys the
site. The refresh builds the exact commit's corpus, generates all embeddings,
upserts them into its versioned namespace, and waits for each accepted mutation
to finish indexing. Only then does it update `AI_CORPUS_NAMESPACE` in the runner's
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
on `develop`, plus preview, other-branch, and in-progress deployments. A rollback
preserves the active deployment and its successful predecessors.

Cleanup reads each retained deployment's environment snapshot to preserve its
`AI_CORPUS_NAMESPACE`. It first deletes obsolete deployments, then deletes vectors
in every unreferenced `corpus-*` namespace, including undeployed evaluation
candidates. Unversioned/foreign namespaces are untouched. Vector deletion waits
for the accepted mutation to finish processing.

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

`ai-refresh` makes paid API calls and edits local `wrangler.toml` only after
indexing succeeds. Refresh itself does not delete older namespaces; post-deploy
cleanup prunes unreferenced versioned vectors. Every production push
currently regenerates the corpus, even when content is unchanged; incremental
embedding reuse is a future cost optimization. Deleted content is absent from
the new active namespace. Retained rollback namespaces continue consuming storage.
Leaving `AI_CORPUS_NAMESPACE` unset is only a migration fallback for deployments
not using the refresh flow. Rollback to an existing deployment retains its pinned
namespace; a manual rollback deployment must restore the previous namespace/model
configuration and avoid running refresh against newer content.

Runtime retrieval outages return 503 instead of pretending no context was found.
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
| `make serve` | Start Hugo development server |
| `make dev-ai` | Run the site with Pages Functions through Wrangler |
| `make build` | Build the site without the production CSS purge |
| `make build-prod` | Build production assets with PostCSS and PurgeCSS |
| `make test` | Run the Node.js unit tests |
| `make audit-content` | Validate content front matter coverage |
| `make audit-urls` | Check links using markdown-link-check |
| `make audit-site` | Run content and link checks |
| `make clean` | Remove generated files |
| `make deploy-pages` | Build production assets and deploy to Cloudflare Pages |
| `make deploy-ai` | Validate and gate an AI corpus/model release before deployment |
| `make ai-refresh` | Rebuild and index the current corpus, then update Wrangler's namespace |
| `make pre-commit` | Run all pre-commit hooks manually |

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

### Build for Production

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
hugo mod get -u github.com/nunocoracao/blowfish/v2

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
