SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

.PHONY: \
	help init update serve dev-ai build build-prod postcss postcss-build deps test ai-embeddings rag-eval favicons clean deploy deploy-pages build-summary audit-content audit-urls audit-site cleanup-deployments ci check-tools check-env

ifneq (,$(wildcard .env))
include .env
export
endif

PROJECT_NAME ?= sg
BRANCH ?= develop
PUBLIC_DIR ?= public
REPORT_DIR ?= reports

HUGO ?= hugo
HUGO_FLAGS ?= --gc --minify --cleanDestinationDir
HUGO_SERVER_FLAGS ?= --gc --ignoreCache
NODE ?= node
NPM ?= npm
CURL ?= curl
WRANGLER ?= npx wrangler

REQUIRED_TOOLS := $(HUGO) $(NODE) $(NPM)

help: ## Show this help message
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

check-tools: ## Validate required tools are installed
	@for tool in $(REQUIRED_TOOLS); do \
		command -v $$tool >/dev/null 2>&1 || { echo "Missing tool: $$tool"; exit 1; }; \
	done

check-env: ## Validate required environment variables are set
	@test -n "$$CLOUDFLARE_ACCOUNT_ID" || (echo "Missing CLOUDFLARE_ACCOUNT_ID" && exit 1)
	@test -n "$$CLOUDFLARE_API_TOKEN" || (echo "Missing CLOUDFLARE_API_TOKEN" && exit 1)

init: ## Initialize git submodules
	git submodule update --init --recursive

update: ## Update git submodules
	git submodule update --recursive --remote

serve: ## Start Hugo development server
	$(HUGO) server $(HUGO_SERVER_FLAGS)

dev-ai: build ## Start local server with AI Functions (requires Wrangler)
	$(WRANGLER) pages dev $(PUBLIC_DIR)

build: check-tools ## Build the Hugo site
	$(HUGO) $(HUGO_FLAGS)

build-prod: check-tools ## Build with PostCSS/PurgeCSS enabled
	$(MAKE) postcss-build
	HUGO_ENV=production NODE_ENV=production $(HUGO) $(HUGO_FLAGS)

postcss: build-prod ## Alias for PostCSS/PurgeCSS build

postcss-build: check-tools ## Generate purged CSS for production builds
	HUGO_ENV=production NODE_ENV=production npx postcss assets/css/site.css -o assets/css/site.purged.css

deps: ## Install Node dependencies
	$(NPM) install

test: ## Run unit tests
	$(NPM) test

ai-embeddings: check-tools check-env deps ## Generate AI embeddings (uses .env for secrets)
	$(NODE) scripts/generate_embeddings.mjs

rag-eval: check-tools check-env deps ## Score RAG retrieval quality (hit@3, pass rate ≥75%)
	npx promptfoo@latest eval --pass-rate 0.75

audit-content: check-tools deps ## Validate content front matter coverage
	@REPORT_DIR="$(REPORT_DIR)" \
	$(NODE) scripts/audit_content.mjs

audit-urls: check-tools deps ## Check external links in content files
	find content -name "*.md" | xargs npx markdown-link-check --config .markdown-link-check.json --quiet

audit-site: audit-content audit-urls ## Run content and link checks

favicons: ## Generate favicon files
	@bash scripts/generate_favicons.sh

clean: ## Clean generated files
	rm -rf $(PUBLIC_DIR)/

deploy: build ## Build and deploy (customize as needed)
	@echo "Build complete. Customize this target for your deployment method."

deploy-pages: check-tools check-env build-prod ## Deploy to Cloudflare Pages (uses .env for secrets)
	@COMMIT_HASH=$$(git rev-parse HEAD); \
	COMMIT_MESSAGE=$$(git log -1 --pretty=%s); \
	$(WRANGLER) pages deploy $(PUBLIC_DIR) --project-name=$(PROJECT_NAME) --branch=$(BRANCH) --commit-hash=$$COMMIT_HASH --commit-message="$$COMMIT_MESSAGE"

build-summary: ## Print build output summary
	@echo "=== Build Output Summary ==="
	@echo "Total files: $$(find $(PUBLIC_DIR) -type f | wc -l)"
	@echo "Total directories: $$(find $(PUBLIC_DIR) -type d | wc -l)"
	@echo "Total size: $$(du -sh $(PUBLIC_DIR) | cut -f1)"
	@echo ""
	@echo "=== File type breakdown ==="
	@echo "HTML files: $$(find $(PUBLIC_DIR) -name "*.html" -type f | wc -l) ($$(find $(PUBLIC_DIR) -name "*.html" -type f -exec du -ch {} + 2>/dev/null | tail -1 | cut -f1))"
	@echo "CSS files: $$(find $(PUBLIC_DIR) -name "*.css" -type f | wc -l) ($$(find $(PUBLIC_DIR) -name "*.css" -type f -exec du -ch {} + 2>/dev/null | tail -1 | cut -f1))"
	@echo "JS files: $$(find $(PUBLIC_DIR) -name "*.js" -type f | wc -l) ($$(find $(PUBLIC_DIR) -name "*.js" -type f -exec du -ch {} + 2>/dev/null | tail -1 | cut -f1))"
	@echo "Image files: $$(find $(PUBLIC_DIR) \( -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" -o -name "*.webp" -o -name "*.svg" \) -type f | wc -l) ($$(find $(PUBLIC_DIR) \( -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" -o -name "*.webp" -o -name "*.svg" \) -type f -exec du -ch {} + 2>/dev/null | tail -1 | cut -f1))"
	@echo ""
	@echo "=== Largest files ==="
	@find $(PUBLIC_DIR) -type f -exec du -h {} + | sort -rh | head -10

cleanup-deployments: check-tools check-env deps ## Delete all but the most recent Pages deployment
	$(NODE) scripts/cleanup_deployments.mjs

ci: check-tools check-env audit-site ai-embeddings deploy-pages build-summary  ## Run the full CI flow locally

pre-commit: ## Run pre-commit hooks manually
	@pre-commit validate-config
	@pre-commit run --all-files --color auto
