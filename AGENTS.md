# Agent Guide

Use [README.md](README.md) for setup, architecture, commands, evaluation,
deployment and operational limits. Use [tests/README.md](tests/README.md) for
test patterns. Keep general documentation there rather than duplicating it here.

## Working conventions

- Prefer Make targets: they handle tool checks and environment wiring.
- Install locked dependencies explicitly with `make deps`; audits and tests must
  not install packages implicitly.
- Validate relevant changes with focused tests, `make lint` and, for Functions
  changes, `make ai-build`. `make ci-check` is the broader offline validation.
- Keep test cases and nested suites alphabetized case-insensitively. Files use
  Node's default parallel execution; do not serialize them for output ordering.
- Use installed Cloudflare SDK signatures and real-SDK/mock-fetch contract tests.
  Lightweight stubs alone can miss breaking SDK changes.
- Do not run paid inference, deploy, or delete cloud resources without approval.
  `make ci` is a paid production flow, not an offline check.

## Site and Hugo pitfalls

- Hugo uses the Blowfish module; do not vendor the theme. Use Hugo module tools
  for updates and inspect the module cache for templates not overridden locally.
- `layouts/` contains theme overrides, not the complete theme.
- Posts need `description` front matter for page metadata and social previews.
- Do not duplicate OG/Twitter tags or `<html lang>`; Blowfish already emits them.
- Template data lookups use `site.Data.X`, not deprecated `.Site.Data.X`.
- Prefer `resources.Minify` and `resources.Fingerprint` in new pipeline code.
- Valid Hugo cache names are `assets`, `getresource`, `images`, `modules`, `misc`;
  do not restore removed `getcsv`/`getjson` entries.
- PostCSS/PurgeCSS must precede production Hugo builds. Preserve dynamic widget
  classes in the existing safelist.

## Content and chat

- `content/posts/` and `content/portfolio/` contain public content;
  `content/_context/` is internal RAG corpus, not user-facing pages.
- `data/chat_suggestions.yml` feeds the chat suggestion shortcode.
- Shared model settings, prompts and limits live in
  `functions/_lib/application.js`; corpus logic lives in `scripts/lib/`.
- Corpus CLI scripts use `.mjs`, including `scripts/generate_embeddings.mjs`.
- `make ai-refresh` skips unchanged production corpora;
  `AI_REFRESH_FLAGS=--force` rebuilds a missing/damaged index.
- Do not invent benchmark results: mock tests and substring checks do not measure
  provider quality, factual accuracy, production latency or production cost.
- Visitor transcripts are intentionally public for the current demo. Do not
  publish them as test fixtures or benchmark examples.

## Production safety

- `develop` is the production branch; there is no separate `main`.
- Cleanup retains the active deployment plus five successful production
  predecessors, and preserves other-branch/in-progress production deployments.
- All previews are targeted, including in-progress previews; force deletion is
  preview-only. Vector pruning follows deployment deletion and preserves
  namespaces referenced by retained deployment snapshots.
- Keep active-ID, fresh inventory, namespace and mutation-readiness checks.
  Serialized CI does not lock out manual cloud writers.
- Paid embedding requests do not retry. On failure, queued inference is prevented
  and in-flight requests are aborted; started inference may still incur charges.
