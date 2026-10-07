SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

.PHONY: \
	help serve dev-ai \
	build build-prod postcss-build build-summary clean \
	deps test audit-content audit-urls audit-site rag-eval pre-commit \
	ai-models ai-check ai-plan ai-test ai-build ai-embeddings ai-refresh ai-retrieval-eval ai-compare ai-compare-rag ai-release-check deploy-ai \
	deploy-pages cleanup-deployments \
	ci check-tools check-env check-ai-tools check-ai-namespace check-wrangler-node

ifneq (,$(wildcard .env))
include .env
export
endif

# ── Config ─────────────────────────────────────────────────────────────────────
PROJECT_NAME      ?= sg
BRANCH            ?= develop
PUBLIC_DIR        ?= public
REPORT_DIR        ?= reports
AI_MODELS         ?= glm,gemma,llama
AI_NAMESPACE      ?=
AI_REPEATS        ?= 1
AI_FIXTURE        ?= tests/fixtures/ai-eval.json
AI_MIN_HIT_RATE   ?= 0.9
AI_MIN_ANSWER_RATE ?= 0.8
AI_TIMEOUT_MS     ?= 60000
AI_RETRIEVAL_REPORT ?= $(REPORT_DIR)/ai-retrieval.json
AI_COMPARISON_REPORT ?= $(REPORT_DIR)/ai-comparison.json
export AI_MODELS AI_NAMESPACE AI_REPEATS AI_FIXTURE AI_MIN_HIT_RATE AI_MIN_ANSWER_RATE AI_TIMEOUT_MS
export AI_RETRIEVAL_REPORT AI_COMPARISON_REPORT REPORT_DIR

HUGO              ?= hugo
HUGO_FLAGS        ?= --gc --minify --cleanDestinationDir
HUGO_SERVER_FLAGS ?= --gc --ignoreCache
NODE              ?= node
NPM               ?= npm
WRANGLER          ?= npx wrangler

REQUIRED_TOOLS := $(HUGO) $(NODE) $(NPM)

# ── Help ───────────────────────────────────────────────────────────────────────
help: ## Show available targets
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)

# ── Guards ─────────────────────────────────────────────────────────────────────
check-tools: ## Validate required tools are installed
	@for tool in $(REQUIRED_TOOLS); do \
		command -v $$tool >/dev/null 2>&1 || { echo "Missing tool: $$tool"; exit 1; }; \
	done

check-env: ## Validate required environment variables are set
	@test -n "$${CLOUDFLARE_ACCOUNT_ID:-}" || (echo "Missing CLOUDFLARE_ACCOUNT_ID" && exit 1)
	@test -n "$${CLOUDFLARE_API_TOKEN:-}"  || (echo "Missing CLOUDFLARE_API_TOKEN"  && exit 1)

check-ai-tools: ## Validate Node/npm without requiring Hugo
	@command -v $(NODE) >/dev/null || { echo "Missing Node"; exit 1; }
	@command -v $(NPM) >/dev/null || { echo "Missing npm"; exit 1; }

check-ai-namespace:
	@test -n "$$AI_NAMESPACE" || { echo "Set AI_NAMESPACE to the candidate namespace printed by make ai-plan"; exit 1; }

check-wrangler-node: check-ai-tools
	@$(NODE) -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Wrangler requires Node.js 22+"); process.exit(1); }'

##@ Development
serve: ## Start Hugo development server
	$(HUGO) server $(HUGO_SERVER_FLAGS)

dev-ai: build ## Start local dev server with Cloudflare Workers AI
	$(WRANGLER) pages dev $(PUBLIC_DIR)

##@ Build
build: check-tools ## Build the site (development)
	$(HUGO) $(HUGO_FLAGS)

postcss-build: check-tools ## Run PostCSS + PurgeCSS (production CSS only)
	HUGO_ENV=production NODE_ENV=production npx postcss assets/css/site.css -o assets/css/site.purged.css

build-prod: check-tools postcss-build ## Build the site for production (with PurgeCSS)
	HUGO_ENV=production NODE_ENV=production $(HUGO) $(HUGO_FLAGS)

build-summary: ## Print a summary of the build output
	@echo "=== Build Output ==="
	@echo "Files : $$(find $(PUBLIC_DIR) -type f | wc -l | tr -d ' ')"
	@echo "Size  : $$(du -sh $(PUBLIC_DIR) | cut -f1)"
	@echo "HTML  : $$(find $(PUBLIC_DIR) -name '*.html' | wc -l | tr -d ' ')"
	@echo "CSS   : $$(find $(PUBLIC_DIR) -name '*.css'  | wc -l | tr -d ' ')"
	@echo "JS    : $$(find $(PUBLIC_DIR) -name '*.js'   | wc -l | tr -d ' ')"
	@echo "Images: $$(find $(PUBLIC_DIR) \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' -o -name '*.webp' -o -name '*.svg' \) | wc -l | tr -d ' ')"
	@echo ""
	@echo "=== Largest files ==="
	@find $(PUBLIC_DIR) -type f -exec du -h {} + | sort -rh | head -10

clean: ## Remove the build output directory
	rm -rf $(PUBLIC_DIR)/

##@ Test & Audit
deps: ## Install Node dependencies
	$(NPM) install

test: ## Run unit tests
	$(NPM) test

audit-content: check-tools deps ## Validate content front matter coverage
	@REPORT_DIR="$(REPORT_DIR)" $(NODE) scripts/audit_content.mjs

audit-urls: check-tools deps ## Check external links in content files
	find content -name "*.md" | xargs npx markdown-link-check --config .markdown-link-check.json --quiet

audit-site: audit-content audit-urls ## Run all content and link audits

rag-eval: ai-retrieval-eval ## Run labeled source retrieval evaluation (alias)

pre-commit: ## Run pre-commit hooks against all files
	@pre-commit validate-config
	@pre-commit run --all-files --color auto

##@ AI
ai-models: check-ai-tools ## List model aliases, parameters and dated prices (offline)
	$(NODE) scripts/ai-eval.mjs models

ai-plan: check-ai-tools ## Validate corpus and write candidate manifest (offline)
	$(NODE) scripts/generate_embeddings.mjs --check --manifest "$$REPORT_DIR/ai-corpus.json"

ai-check: check-ai-tools ## Validate corpus IDs, model selection and evaluation labels (offline)
	$(NODE) scripts/generate_embeddings.mjs --check
	$(NODE) scripts/ai-eval.mjs validate --models "$$AI_MODELS" --fixture "$$AI_FIXTURE"

ai-test: check-ai-tools ## Run offline AI infrastructure and API tests
	$(NODE) --test tests/unit/*.test.mjs

ai-build: check-wrangler-node ## Bundle Pages Functions locally (Node 22+, no deployment)
	mkdir -p "$$REPORT_DIR"
	$(WRANGLER) pages functions build functions --outfile="$$REPORT_DIR/ai-functions-worker.js"

ai-embeddings: check-ai-tools check-env check-ai-namespace ## Ingest explicit candidate namespace (paid API; no activation/deletion)
	$(NODE) scripts/generate_embeddings.mjs --namespace "$$AI_NAMESPACE" --manifest "$$REPORT_DIR/ai-corpus.json"

ai-refresh: check-ai-tools check-env ## Rebuild embeddings, wait for indexing and update Wrangler namespace (paid API)
	$(NODE) scripts/refresh_ai_corpus.mjs

ai-retrieval-eval: check-ai-tools check-env check-ai-namespace ## Evaluate live hit@k against labeled sources (paid API)
	$(NODE) scripts/ai-eval.mjs retrieval --namespace "$$AI_NAMESPACE" --fixture "$$AI_FIXTURE" \
		--min-hit-rate "$$AI_MIN_HIT_RATE" --timeout-ms "$$AI_TIMEOUT_MS" --output "$$AI_RETRIEVAL_REPORT"

ai-compare: check-ai-tools check-env ## Compare models using identical labeled-source contexts (paid API)
	$(NODE) scripts/ai-eval.mjs compare --models "$$AI_MODELS" --fixture "$$AI_FIXTURE" \
		--repeats "$$AI_REPEATS" --timeout-ms "$$AI_TIMEOUT_MS" --output "$$AI_COMPARISON_REPORT"

ai-compare-rag: check-ai-tools check-env check-ai-namespace ## Compare models using a validated live retrieval report (paid API)
	$(NODE) scripts/ai-eval.mjs compare --namespace "$$AI_NAMESPACE" --models "$$AI_MODELS" \
		--fixture "$$AI_FIXTURE" --retrieval-report "$$AI_RETRIEVAL_REPORT" --min-hit-rate "$$AI_MIN_HIT_RATE" \
		--repeats "$$AI_REPEATS" --timeout-ms "$$AI_TIMEOUT_MS" --output "$$AI_COMPARISON_REPORT"

ai-release-check: check-ai-tools check-ai-namespace ## Gate activation using retrieval/model reports and Wrangler settings (offline)
	$(NODE) scripts/ai-eval.mjs release-check --namespace "$$AI_NAMESPACE" --fixture "$$AI_FIXTURE" \
		--retrieval-report "$$AI_RETRIEVAL_REPORT" --comparison-report "$$AI_COMPARISON_REPORT" \
		--min-hit-rate "$$AI_MIN_HIT_RATE" --min-answer-rate "$$AI_MIN_ANSWER_RATE"

deploy-ai: ## Run offline checks and candidate release gate before Pages deployment
	$(MAKE) ai-check ai-test
	$(MAKE) ai-release-check
	$(MAKE) ai-build
	$(MAKE) deploy-pages

##@ Deploy
deploy-pages: check-tools check-env build-prod ## Build (prod) and deploy to Cloudflare Pages
	@COMMIT_HASH=$$(git rev-parse HEAD); \
	COMMIT_MESSAGE=$$(git log -1 --pretty=%s); \
	$(WRANGLER) pages deploy $(PUBLIC_DIR) \
		--project-name=$(PROJECT_NAME) \
		--branch=$(BRANCH) \
		--commit-hash=$$COMMIT_HASH \
		--commit-message="$$COMMIT_MESSAGE"

cleanup-deployments: check-tools check-env deps ## Delete all but the latest Pages deployment
	$(NODE) scripts/cleanup_deployments.mjs

favicons: ## Regenerate favicon assets
	@bash scripts/generate_favicons.sh

kill:
	kill -9 $(lsof -t -i:1313)

##@ CI
ci: ## Run checks, refresh embeddings and deploy the matching chat corpus
	$(MAKE) test ai-check audit-site
	$(MAKE) ai-refresh
	$(MAKE) deploy-pages
	$(MAKE) build-summary
