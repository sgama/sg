SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help init update serve dev-ai build ai-embeddings favicons clean deploy deploy-pages build-summary cleanup-deployments ci check-tools check-env

ifneq (,$(wildcard .env))
include .env
export
endif

PROJECT_NAME ?= sg
BRANCH ?= develop
PUBLIC_DIR ?= public

HUGO ?= hugo
NODE ?= node
NPM ?= npm
CURL ?= curl
WRANGLER ?= npx wrangler
JQ ?= jq

REQUIRED_TOOLS := $(HUGO) $(NODE) $(NPM) $(JQ) $(CURL)

help: ## Show this help message
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

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
	$(HUGO) server --gc --ignoreCache

dev-ai: build ## Start local server with AI Functions (requires Wrangler)
	$(WRANGLER) pages dev $(PUBLIC_DIR)

build: ## Build the Hugo site
	$(HUGO) --gc --minify

ai-embeddings: check-tools check-env ## Generate AI embeddings (uses .env for secrets)
	$(NPM) install
	$(NODE) scripts/generate_embeddings.js

favicons: ## Generate favicon files
	@bash scripts/generate_favicons.sh

clean: ## Clean generated files
	rm -rf $(PUBLIC_DIR)/

deploy: build ## Build and deploy (customize as needed)
	@echo "Build complete. Customize this target for your deployment method."

deploy-pages: check-tools check-env build ## Deploy to Cloudflare Pages (uses .env for secrets)
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
	@echo "HTML files: $$(find $(PUBLIC_DIR) -name "*.html" -type f | wc -l) ($$(du -ch $(PUBLIC_DIR)/**/*.html 2>/dev/null | tail -1 | cut -f1))"
	@echo "CSS files: $$(find $(PUBLIC_DIR) -name "*.css" -type f | wc -l) ($$(du -ch $(PUBLIC_DIR)/**/*.css 2>/dev/null | tail -1 | cut -f1))"
	@echo "JS files: $$(find $(PUBLIC_DIR) -name "*.js" -type f | wc -l) ($$(du -ch $(PUBLIC_DIR)/**/*.js 2>/dev/null | tail -1 | cut -f1))"
	@echo "Image files: $$(find $(PUBLIC_DIR) \( -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" -o -name "*.webp" -o -name "*.svg" \) -type f | wc -l) ($$(du -ch $(PUBLIC_DIR)/**/*.{jpg,jpeg,png,webp,svg} 2>/dev/null | tail -1 | cut -f1))"
	@echo ""
	@echo "=== Largest files ==="
	@find $(PUBLIC_DIR) -type f -exec du -h {} + | sort -rh | head -10

cleanup-deployments: check-tools check-env ## Delete all but latest Pages deployment (uses .env for secrets)
	@ACCOUNT_ID="$$CLOUDFLARE_ACCOUNT_ID"; \
	PROJECT_NAME="$(PROJECT_NAME)"; \
	BRANCH_NAME="$(BRANCH)"; \
	$(CURL) -s \
	  -H "Authorization: Bearer $$CLOUDFLARE_API_TOKEN" \
	  "https://api.cloudflare.com/client/v4/accounts/$$ACCOUNT_ID/pages/projects/$$PROJECT_NAME/deployments" \
	| $(JQ) -r '(.result // [])
	    | map(select((.deployment_trigger.metadata.branch // .deployment_trigger.metadata.branch_name // .deployment_trigger.metadata.commit_ref // "") == "'"$$BRANCH_NAME"'"))
	    | sort_by(.created_on)
	    | reverse
	    | .[1:]
	    | .[].id' \
	| while read -r DEPLOYMENT_ID; do \
	    echo "Deleting deployment $$DEPLOYMENT_ID"; \
	    $(CURL) -s -X DELETE \
	      -H "Authorization: Bearer $$CLOUDFLARE_API_TOKEN" \
	      "https://api.cloudflare.com/client/v4/accounts/$$ACCOUNT_ID/pages/projects/$$PROJECT_NAME/deployments/$$DEPLOYMENT_ID"; \
	  done

ci: check-tools check-env build ai-embeddings deploy-pages build-summary cleanup-deployments ## Run the full CI flow locally

pre-commit: ## Run pre-commit hooks manually
	@pre-commit validate-config
	@pre-commit run --all-files --color auto
