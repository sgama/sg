# Agent Guide

Use [README.md](README.md) for setup, architecture, commands, evaluation,
deployment and operational limits. Use [tests/README.md](tests/README.md) for
test patterns. Keep general documentation there rather than duplicating it here.

## Working conventions

- Prefer Make targets: they handle tool checks and environment wiring.
- Install locked dependencies explicitly with `make deps`; audits and tests must
  not install packages implicitly.
- Validate relevant changes with focused tests, `make lint`, `make typecheck` (JSDoc types, checked by
  `tsc` in three environments: `tsconfig.json` Functions, `tsconfig.scripts.json`, `tsconfig.browser.json`) and, for Functions
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
- Template data lookups use `hugo.Data.X`; both `site.Data.X` and `.Site.Data.X` are deprecated.
- Scripts loaded by URL with `import()` (the chat Markdown entry) need `"format" "esm"` in `js.Build`;
  the default IIFE exports nothing. `assets/lib/mermaid/mermaid.min.js` overrides the theme's
  5.5 MB Mermaid with a facade over the chunked ESM build in `/vendor/mermaid/`.
- Prefer `resources.Minify` and `resources.Fingerprint` in new pipeline code.
- Valid Hugo cache names are `assets`, `getresource`, `images`, `modules`, `misc`;
  do not restore removed `getcsv`/`getjson` entries.
- PostCSS/PurgeCSS must precede production Hugo builds. Preserve dynamic widget
  classes in the existing safelist.

## Content and chat

- `content/posts/` and `content/portfolio/` contain public content;
  `content/_context/` is internal RAG corpus, not user-facing pages.
- `data/prompts.yml` feeds the chat suggestion shortcode with employer questions.
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
- The site is one Cloudflare Worker with static assets (`wrangler.toml`; `functions/worker.js` runs
  first only for `/api/*`). It has one live version and no deployment history; rollback means
  redeploying an earlier commit. The live version records `AI_CORPUS_NAMESPACE` and `DEPLOY_COMMIT`
  as plain-text variables, which refresh, deploy-skip and cleanup read.
- `make cleanup-vectors` retains the live namespace and one prior namespace, deleting only older
  versioned corpora. It refuses to run without a live namespace and stops if a deploy changes it mid-run.
  It does not wait for Vectorize to process deletions: queries are namespace-scoped, and reruns are idempotent.
- `make cutover-domains` is a one-time Pages-to-Worker custom domain move; the Pages project is
  frozen until it has run.
- CI skips the corpus refresh and deployment when no file that can change the site
  differs from the commit the live Worker was built from
  (`scripts/deploy_needed.mjs`, `make deploy-needed`); any doubt deploys. The vector
  cleanup runs only after a deploy, since a skipped deploy leaves nothing stale.
  Edit its `DEPLOY_INPUTS` list when adding a directory that affects the build.
- Keep active-ID, fresh inventory, namespace and mutation-readiness checks.
  Serialized CI does not lock out manual cloud writers.
- Paid embedding requests do not retry. On failure, queued inference is prevented
  and in-flight requests are aborted; started inference may still incur charges.
