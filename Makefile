SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

.PHONY: \
	help serve dev-ai \
	build build-prod postcss-build build-summary clean \
	bom metrics metrics-json check-scc install-scc \
	deps test test-layouts lint lint-fix format format-check lint-workflows install-actionlint coverage audit-content audit-urls audit-site audit-rag rag-eval pre-commit \
	ai-models ai-check ai-plan ai-test ai-build ai-embeddings ai-refresh ai-retrieval-eval ai-compare ai-compare-rag ai-release-check ai-local-check ai-local-validate ai-local-hybrid ai-local-clean deploy-ai \
	deploy-pages deploy-built cleanup-deployments \
	ci ci-check check-tools check-env check-ai-tools check-ai-namespace check-wrangler-node

ifneq (,$(wildcard .env))
include .env
export
endif

# ── Config ─────────────────────────────────────────────────────────────────────
PROJECT_NAME      ?= sg
BRANCH            ?= develop
PUBLIC_DIR        ?= public
DEV_PORT          ?= 8788
REPORT_DIR        ?= reports
AI_MODELS         ?= glm,gemma,llama
AI_NAMESPACE      ?=
AI_REFRESH_FLAGS  ?=
AI_REPEATS        ?= 1
AI_FIXTURE        ?= tests/fixtures/ai-eval.json
AI_MIN_HIT_RATE   ?= 0.9
AI_MIN_ANSWER_RATE ?= 0.8
AI_TIMEOUT_MS     ?= 60000
AI_RETRIEVAL_REPORT ?= $(REPORT_DIR)/ai-retrieval.json
AI_COMPARISON_REPORT ?= $(REPORT_DIR)/ai-comparison.json
DOCKER            ?= docker
AI_LOCAL_IMAGE    ?= ollama/ollama:latest
AI_LOCAL_VOLUME   ?= sg-ollama-models
AI_LOCAL_MODEL    ?= hf.co/unsloth/GLM-4.7-Flash-GGUF:GLM-4.7-Flash-UD-IQ3_XXS.gguf
AI_LOCAL_CONTEXT  ?= 4096
AI_LOCAL_EMBED_MODEL ?= BAAI/bge-base-en-v1.5
AI_LOCAL_EMBED_IMAGE ?= ghcr.io/huggingface/text-embeddings-inference:cuda-1.9
AI_LOCAL_GENERATION ?= local
AI_LOCAL_CLOUD_MODEL ?= glm
AI_LOCAL_DIMENSIONS ?= 768
AI_LOCAL_TIMEOUT_MS ?= 120000
AI_LOCAL_REPORT   ?= $(REPORT_DIR)/ai-local.json
export DOCKER AI_LOCAL_IMAGE AI_LOCAL_VOLUME AI_LOCAL_MODEL AI_LOCAL_EMBED_MODEL
export AI_LOCAL_DIMENSIONS AI_LOCAL_TIMEOUT_MS AI_LOCAL_REPORT
export AI_LOCAL_EMBED_IMAGE AI_LOCAL_GENERATION AI_LOCAL_CLOUD_MODEL
export AI_LOCAL_CONTEXT
export AI_MODELS AI_NAMESPACE AI_REPEATS AI_FIXTURE AI_MIN_HIT_RATE AI_MIN_ANSWER_RATE AI_TIMEOUT_MS
export AI_RETRIEVAL_REPORT AI_COMPARISON_REPORT REPORT_DIR
export PUBLIC_DIR

HUGO              ?= hugo
HUGO_FLAGS        ?= --minify --cleanDestinationDir
HUGO_SERVER_FLAGS ?=
NODE              ?= node
export NODE
NPM               ?= npm
WRANGLER          ?= npx wrangler
TEST_REPORTER     ?= spec
ACTIONLINT        ?= actionlint
ACTIONLINT_VERSION := v1.7.7
SCC               ?= scc
SCC_VERSION       := v4.1.0
SCC_FLAGS         := --no-cocomo --exclude-dir .git,node_modules,public,resources,reports,coverage,.wrangler,.npm \
	--exclude-file site.purged.css,package-lock.json,go.sum
export ACTIONLINT_VERSION

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
	@sha=$$(git rev-parse HEAD) && HUGO_BUILD_SHA="$$sha" $(HUGO) server $(HUGO_SERVER_FLAGS)

dev-ai: check-wrangler-node build ## Start local dev server with Cloudflare Workers AI
	@$(WRANGLER) pages dev "$(PUBLIC_DIR)" --port=$(DEV_PORT)

##@ Build
build: check-tools ## Build the site (development)
	@sha=$$(git rev-parse HEAD) && HUGO_BUILD_SHA="$$sha" $(HUGO) $(HUGO_FLAGS) --destination "$(PUBLIC_DIR)"

postcss-build: check-tools ## Run PostCSS + PurgeCSS (production CSS only)
	@HUGO_ENV=production NODE_ENV=production npx postcss assets/css/site.css -o assets/css/site.purged.css

build-prod: check-tools postcss-build ## Build the site for production (with PurgeCSS)
	@sha=$$(git rev-parse HEAD) && HUGO_BUILD_SHA="$$sha" HUGO_ENV=production NODE_ENV=production $(HUGO) $(HUGO_FLAGS) --destination "$(PUBLIC_DIR)"

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

clean: ## Remove generated output within the repository's public build tree
	@test -n "$$PUBLIC_DIR" || { echo "Refusing cleanup: PUBLIC_DIR is empty"; exit 1; }
	@root=$$(git rev-parse --show-toplevel); \
	target=$$(realpath -m -- "$$PUBLIC_DIR"); \
	case "$$target" in \
		"$$root/public"|"$$root/public/"*) ;; \
		*) echo "Refusing cleanup outside $$root/public: $$target"; exit 1 ;; \
	esac; \
	test -z "$$(git ls-files -- "$$target")" || { echo "Refusing cleanup of tracked files: $$target"; exit 1; }; \
	rm -rf -- "$$target"

##@ Test & Audit
check-scc:
	@command -v $(SCC) >/dev/null || { \
		echo "Missing scc; install with: make install-scc" >&2; \
		echo 'Add $$(go env GOPATH)/bin to PATH or set SCC=/path/to/scc' >&2; \
		exit 1; \
	}

install-scc: ## Install the pinned source metrics tool using Go
	@go install github.com/boyter/scc/v4@$(SCC_VERSION)

bom: metrics ## Alias for source metrics (not a dependency SBOM)

metrics: check-scc ## Print native scc source inventory, line counts, size and complexity estimates
	@$(SCC) $(SCC_FLAGS) --wide .

metrics-json: check-scc ## Print native scc source inventory as JSON to stdout
	@$(SCC) $(SCC_FLAGS) --format json .

deps: check-ai-tools ## Install Node dependencies exactly from the lockfile
	@$(NPM) ci --no-fund

test: ## Run unit tests
	@$(NODE) --test --test-timeout=30000 --test-reporter=$(TEST_REPORTER) tests/unit/*.test.mjs

test-layouts: check-tools ## Build Hugo fixtures and validate schema, public index, preloads and theme settings
	@HUGO="$(HUGO)" $(NODE) --test --test-timeout=120000 --test-reporter=$(TEST_REPORTER) tests/integration/layouts.test.mjs

lint: check-ai-tools ## Lint all JavaScript with ESLint
	@$(NPM) --silent run lint

lint-fix: check-ai-tools ## Apply safe ESLint fixes
	@$(NPM) --silent run lint:fix

format: check-ai-tools ## Format JavaScript, source CSS and YAML (no Hugo content/templates)
	@$(NPM) --silent run format

format-check: check-ai-tools ## Check JavaScript, source CSS and YAML formatting without edits
	@$(NPM) --silent run format:check

lint-workflows: ## Validate GitHub Actions with native actionlint
	@command -v $(ACTIONLINT) >/dev/null || { \
		echo "Missing actionlint; install with: go install github.com/rhysd/actionlint/cmd/actionlint@$(ACTIONLINT_VERSION)"; \
		echo 'Add $$(go env GOPATH)/bin to PATH or set ACTIONLINT=/path/to/actionlint'; \
		exit 1; \
	}
	@$(ACTIONLINT)

install-actionlint: ## Install the pinned actionlint release using Go
	@go install github.com/rhysd/actionlint/cmd/actionlint@$(ACTIONLINT_VERSION)

coverage: check-ai-tools ## Run offline tests with text, HTML and LCOV coverage
	@$(NPM) --silent run test:coverage

audit-content: check-ai-tools ## Validate content front matter coverage (install dependencies first)
	@REPORT_DIR="$(REPORT_DIR)" $(NODE) scripts/audit_content.mjs

audit-urls: check-ai-tools ## Check external links (install dependencies first)
	@find content -name "*.md" -print0 | xargs -0 -r ./node_modules/.bin/markdown-link-check --config .markdown-link-check.json --quiet

audit-site: audit-content audit-urls ## Run all content and link audits

audit-rag: check-ai-tools ## Audit RAG prompt coverage, provenance and authoring gaps (offline)
	@$(NODE) scripts/audit_rag.mjs

rag-eval: ai-retrieval-eval ## Run labeled source retrieval evaluation (alias)

pre-commit: ## Run pre-commit hooks against all files
	@pre-commit validate-config
	@pre-commit run --all-files --color auto

##@ AI
ai-local-check: check-ai-tools ## Validate local RAG settings and fixture without Docker or inference
	@$(NODE) scripts/ai-local-eval.mjs --dry-run --model "$$AI_LOCAL_MODEL" \
		--context-tokens "$$AI_LOCAL_CONTEXT" \
		--generation "$$AI_LOCAL_GENERATION" --cloud-model "$$AI_LOCAL_CLOUD_MODEL" \
		--embedding-model "$$AI_LOCAL_EMBED_MODEL" --dimensions "$$AI_LOCAL_DIMENSIONS" \
		--fixture "$$AI_FIXTURE" --repeats "$$AI_REPEATS" --timeout-ms "$$AI_LOCAL_TIMEOUT_MS" \
		--min-hit-rate "$$AI_MIN_HIT_RATE" --min-answer-rate "$$AI_MIN_ANSWER_RATE"

ai-local-validate: ai-local-check ## Run full local RAG on Docker/GPU; report, remove container and exit
	@command -v "$(DOCKER)" >/dev/null || { echo "Missing Docker"; exit 1; }
	@command -v curl >/dev/null || { echo "Missing curl"; exit 1; }
	@bash scripts/run_local_ai.sh

ai-local-clean: ## Delete the owned local model-cache volume (fails if in use)
	@bash scripts/run_local_ai.sh clean

ai-local-hybrid: check-env ## Local BGE retrieval + Cloudflare generation (paid); tear down and exit
	@$(MAKE) --no-print-directory ai-local-validate AI_LOCAL_GENERATION=cloudflare \
		AI_LOCAL_REPORT="$(REPORT_DIR)/ai-local-hybrid.json"

ai-models: check-ai-tools ## List model aliases, parameters and dated prices (offline)
	@$(NODE) scripts/ai-eval.mjs models

ai-plan: check-ai-tools ## Validate corpus and write candidate manifest (offline)
	@$(NODE) scripts/generate_embeddings.mjs --check --manifest "$$REPORT_DIR/ai-corpus.json"

ai-check: check-ai-tools ## Validate corpus IDs, model selection and evaluation labels (offline)
	@$(NODE) scripts/generate_embeddings.mjs --check
	@$(NODE) scripts/ai-eval.mjs validate --models "$$AI_MODELS" --fixture "$$AI_FIXTURE"

ai-test: check-ai-tools ## Run offline AI infrastructure and API tests
	@$(NODE) --test --test-timeout=30000 --test-reporter=$(TEST_REPORTER) tests/unit/*.test.mjs

ai-build: check-wrangler-node ## Bundle Pages Functions locally (Node 22+, no deployment)
	@mkdir -p "$$REPORT_DIR"
	@$(WRANGLER) pages functions build functions --outfile="$$REPORT_DIR/ai-functions-worker.js"

ai-embeddings: check-ai-tools check-env check-ai-namespace ## Ingest explicit candidate namespace (paid API; no activation/deletion)
	@$(NODE) scripts/generate_embeddings.mjs --namespace "$$AI_NAMESPACE" --manifest "$$REPORT_DIR/ai-corpus.json"

ai-refresh: check-ai-tools check-env ## Index changed corpus and set namespace (force: AI_REFRESH_FLAGS=--force)
	@$(NODE) scripts/refresh_ai_corpus.mjs $(AI_REFRESH_FLAGS)

ai-retrieval-eval: check-ai-tools check-env check-ai-namespace ## Evaluate live hit@k against labeled sources (paid API)
	@$(NODE) scripts/ai-eval.mjs retrieval --namespace "$$AI_NAMESPACE" --fixture "$$AI_FIXTURE" \
		--min-hit-rate "$$AI_MIN_HIT_RATE" --timeout-ms "$$AI_TIMEOUT_MS" --output "$$AI_RETRIEVAL_REPORT"

ai-compare: check-ai-tools check-env ## Compare models using identical labeled-source contexts (paid API)
	@$(NODE) scripts/ai-eval.mjs compare --models "$$AI_MODELS" --fixture "$$AI_FIXTURE" \
		--repeats "$$AI_REPEATS" --timeout-ms "$$AI_TIMEOUT_MS" --output "$$AI_COMPARISON_REPORT"

ai-compare-rag: check-ai-tools check-env check-ai-namespace ## Compare models using a validated live retrieval report (paid API)
	@$(NODE) scripts/ai-eval.mjs compare --namespace "$$AI_NAMESPACE" --models "$$AI_MODELS" \
		--fixture "$$AI_FIXTURE" --retrieval-report "$$AI_RETRIEVAL_REPORT" --min-hit-rate "$$AI_MIN_HIT_RATE" \
		--repeats "$$AI_REPEATS" --timeout-ms "$$AI_TIMEOUT_MS" --output "$$AI_COMPARISON_REPORT"

ai-release-check: check-ai-tools check-ai-namespace ## Gate activation using retrieval/model reports and Wrangler settings (offline)
	@$(NODE) scripts/ai-eval.mjs release-check --namespace "$$AI_NAMESPACE" --fixture "$$AI_FIXTURE" \
		--retrieval-report "$$AI_RETRIEVAL_REPORT" --comparison-report "$$AI_COMPARISON_REPORT" \
		--min-hit-rate "$$AI_MIN_HIT_RATE" --min-answer-rate "$$AI_MIN_ANSWER_RATE"

deploy-ai: ## Run offline checks and candidate release gate before Pages deployment
	@$(MAKE) --no-print-directory ai-check ai-test
	@$(MAKE) --no-print-directory ai-release-check
	@$(MAKE) --no-print-directory ai-build
	@$(MAKE) --no-print-directory deploy-pages

##@ Deploy
deploy-pages: build-prod ## Build (prod) and deploy to Cloudflare Pages
	@$(MAKE) --no-print-directory deploy-built

deploy-built: check-wrangler-node check-env ## Deploy an already validated production build (no rebuild)
	@test -f "$(PUBLIC_DIR)/index.html" || { echo "Missing site build; run make build-prod first"; exit 1; }
	@COMMIT_HASH=$$(git rev-parse HEAD); \
	COMMIT_MESSAGE=$$(git log -1 --pretty=%s); \
	$(WRANGLER) pages deploy $(PUBLIC_DIR) \
		--project-name=$(PROJECT_NAME) \
		--branch=$(BRANCH) \
		--commit-hash=$$COMMIT_HASH \
		--commit-message="$$COMMIT_MESSAGE"

cleanup-deployments: check-ai-tools check-env ## Keep production rollback history; delete previews and unreferenced corpora
	@$(NODE) scripts/cleanup_deployments.mjs

favicons: ## Regenerate favicon assets
	@bash scripts/generate_favicons.sh

##@ CI
ci-check: lint-workflows lint coverage ai-check ai-build build-prod test-layouts ## Run independent offline checks (use -j2 --output-sync=target)

ci: ## Run checks, refresh embeddings and deploy the matching chat corpus
	@$(MAKE) --no-print-directory --jobs=2 --output-sync=target ci-check audit-site
	@$(MAKE) --no-print-directory ai-refresh
	@$(MAKE) --no-print-directory deploy-built
	@$(MAKE) --no-print-directory build-summary
