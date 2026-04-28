SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

.PHONY: \
	help serve dev-ai \
	build build-prod postcss-build build-summary clean \
	deps test audit-content audit-urls audit-site rag-eval pre-commit \
	ai-embeddings \
	deploy-pages cleanup-deployments \
	ci check-tools check-env

ifneq (,$(wildcard .env))
include .env
export
endif

# ── Config ─────────────────────────────────────────────────────────────────────
PROJECT_NAME      ?= sg
BRANCH            ?= develop
PUBLIC_DIR        ?= public
REPORT_DIR        ?= reports

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
	@test -n "$$CLOUDFLARE_ACCOUNT_ID" || (echo "Missing CLOUDFLARE_ACCOUNT_ID" && exit 1)
	@test -n "$$CLOUDFLARE_API_TOKEN"  || (echo "Missing CLOUDFLARE_API_TOKEN"  && exit 1)

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

rag-eval: check-tools check-env ## Score RAG retrieval quality (hit@3, pass ≥75%)
	npx promptfoo@latest eval --pass-rate 0.75

pre-commit: ## Run pre-commit hooks against all files
	@pre-commit validate-config
	@pre-commit run --all-files --color auto

##@ AI
ai-embeddings: check-tools check-env deps ## Generate and upsert AI embeddings
	$(NODE) scripts/generate_embeddings.mjs

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
ci: check-tools check-env audit-site ai-embeddings deploy-pages build-summary ## Run the full CI flow locally
