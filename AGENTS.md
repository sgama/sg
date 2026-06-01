# Agent Guide

This repository's shared custom agents live in `.github/agents/` so they can be used by assistants other than Claude.

Available agents:

- `site-impact-sre` - optimize content and presentation for proof-heavy staff SRE positioning.
- `cloudflare-stack` - focus on Cloudflare Pages, Functions, Workers AI, Vectorize, KV, and deploy flow.
- `hugo-expert` - focus on Hugo 0.160+ and Blowfish templates, content model, and build warnings.
- `web-perf` - focus on measurable Core Web Vitals, bundle size, image pipeline, and cache tuning.

Use the Claude-specific copies in `.claude/agents/` only if you need backward compatibility with that toolchain.

## samsongama.com - Agent notes

Hugo static site with the Blowfish theme, deployed to Cloudflare Pages. Has a RAG-based "Speak with AI" feature backed by Cloudflare Workers AI + Vectorize.

### Stack

- **Hugo** extended v0.160+ (pinned via `go.mod`; `hugo mod` manages the theme)
- **Blowfish** theme via Hugo module (`github.com/nunocoracao/blowfish/v2`). Do not vendor - let `hugo mod get` handle updates.
- **PostCSS + PurgeCSS** for production CSS (`make postcss-build` -> `assets/css/site.purged.css`)
- **Cloudflare Pages Functions** under `functions/api/` - handles the `/api/chat` RAG endpoint
- **Cloudflare Vectorize** (`portfolio-index`) - embeddings DB, rebuilt via `scripts/generate_embeddings.js`
- **Umami analytics** at `ping.samsongama.com` (self-hosted)

### Commands

Always prefer `make` targets - they handle tool checks and env wiring:

- `make serve` - dev server (Hugo only; no AI functions)
- `make dev-ai` - dev server with `wrangler pages dev` (chat API works)
- `make build` / `make build-prod` - prod build runs PostCSS first
- `make audit-site` - `audit-content` (front matter coverage) + `audit-urls` (relative link check). Node scripts under `scripts/`.
- `make deploy-pages` - builds + `wrangler pages deploy`. Needs `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` in `.env`.
- `make ai-embeddings` - regenerate Vectorize index after content changes
- `make pre-commit` - runs the full hook suite (markdownlint, yamllint, typos, djLint, Hugo build, govulncheck)

### Repo layout gotchas

- `content/posts/` holds blog posts AND portfolio projects (date-prefixed folders, `index.md` + `featured.*`)
- `content/_context/` is RAG corpus - **do not** treat as user-facing content
- `data/chat_suggestions.yml` feeds the chat chip UI (`layouts/shortcodes/chat-suggestions.html`)
- `layouts/` only overrides Blowfish - most of the theme lives in the Hugo module cache; read it there when debugging templates

### Conventions

- **Every post needs `description` in front matter** - Blowfish's meta description falls back `.Params.Summary | default .Params.Description | default .Site.Params.description`. `description` also feeds OG tags.
- **Don't add OG/Twitter/`<html lang>` overrides** - Blowfish's `head.html` and `baseof.html` already emit them from `site.Params.description`, per-page `.Description`, and `isoCode`. Duplicate tags are a common mistake.
- **Don't hand-edit `config.toml` `[caches]` entries** - Hugo 0.160 removed `getcsv`/`getjson`. Valid names: `assets`, `getresource`, `images`, `modules`, `misc`.
- **Template data lookups use `site.Data.X`**, not `.Site.Data.X` (deprecated in Hugo 0.156).
- **Resource pipeline** - bare `minify`/`fingerprint` still work with a deprecation warning; prefer `resources.Minify`/`resources.Fingerprint` in new code but beware partial-scope parse quirks.

### Deployment branch model

- `develop` is the production branch on Cloudflare Pages (`BRANCH=develop` in Makefile). No separate `main`.
- `make cleanup-deployments` prunes all but the latest prod deployment.

### Known current state

- Blowfish was bumped v2.97.0 -> v2.102.0 (April 2026). It fixes Hugo v0.156/v0.158 template deprecations - watch for residual warnings after upgrades.
- Pre-2020 posts now have `description` front matter; newer posts already did.