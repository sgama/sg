SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

.PHONY: help check check-node check-env check-ns \
	serve dev-ai build postcss-build build-prod clean \
	deps test test-layouts lint lint-fix typecheck format format-check lint-workflows install-actionlint coverage \
	audit-content audit-urls audit-site audit-rag \
	ai-models ai-plan ai-check ai-build ai-embeddings ai-refresh ai-retrieval-eval ai-compare ai-compare-rag ai-release-check deploy-ai \
	deploy deploy-built deploy-needed cleanup-vectors cutover-domains ci ci-check

ifneq (,$(wildcard .env))
include .env
export
endif

# ── Config ─────────────────────────────────────────────────────────────────────
WORKER_NAME       ?= sg
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
HUGO              ?= hugo
HUGO_FLAGS        ?= --minify --cleanDestinationDir
HUGO_SERVER_FLAGS ?=
NODE              ?= node
COVERAGE_REPORTERS ?= text-summary html lcov
PRETTIER_FILES    := "assets/js/**/*.js" "functions/**/*.js" "scripts/**/*.mjs" "tests/**/*.mjs" "*.config.js" "assets/css/**/*.css" "*.{yml,yaml}" ".*.{yml,yaml}" "data/**/*.{yml,yaml}" ".github/**/*.{yml,yaml}"
NPM               ?= npm
NPX               ?= npx --no-install
WRANGLER          ?= npx wrangler
TEST_REPORTER     ?= spec
ACTIONLINT        ?= actionlint
ACTIONLINT_VERSION := v1.7.7
ACTIONLINT_NUMBER := $(patsubst v%,%,$(ACTIONLINT_VERSION))
ACTIONLINT_OS     := $(shell uname -s | tr '[:upper:]' '[:lower:]')
ACTIONLINT_ARCH   := $(shell uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
ACTIONLINT_BIN_DIR ?= $(HOME)/.local/bin

export WORKER_NAME PUBLIC_DIR REPORT_DIR
export AI_MODELS AI_NAMESPACE AI_REFRESH_FLAGS AI_REPEATS AI_FIXTURE
export AI_MIN_HIT_RATE AI_MIN_ANSWER_RATE AI_TIMEOUT_MS
export AI_RETRIEVAL_REPORT AI_COMPARISON_REPORT
export HUGO NODE

# ── Guards ─────────────────────────────────────────────────────────────────────
check: ## Verify hugo/node/npm (node 22+ required by wrangler)
	@command -v $(HUGO) >/dev/null || { echo "Missing hugo"; exit 1; }
	@command -v $(NODE) >/dev/null || { echo "Missing node"; exit 1; }
	@command -v $(NPM) >/dev/null || { echo "Missing npm"; exit 1; }
	@$(NODE) -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22+ required"); process.exit(1); }'

check-node: ## Verify node/npm (no Hugo required)
	@command -v $(NODE) >/dev/null || { echo "Missing node"; exit 1; }
	@command -v $(NPM) >/dev/null || { echo "Missing npm"; exit 1; }
	@$(NODE) -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22+ required"); process.exit(1); }'

check-env: ## Verify Cloudflare credentials are set
	@test -n "$${CLOUDFLARE_ACCOUNT_ID:-}" || (echo "Missing CLOUDFLARE_ACCOUNT_ID" && exit 1)
	@test -n "$${CLOUDFLARE_API_TOKEN:-}"  || (echo "Missing CLOUDFLARE_API_TOKEN"  && exit 1)

check-ns:
	@test -n "$$AI_NAMESPACE" || { echo "Set AI_NAMESPACE to the candidate namespace printed by make ai-plan"; exit 1; }

# ── Help ───────────────────────────────────────────────────────────────────────
help: ## Show available targets
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)

##@ Development
serve: check ## Start Hugo development server
	@sha=$$(git rev-parse HEAD) && HUGO_BUILD_SHA="$$sha" $(HUGO) server $(HUGO_SERVER_FLAGS)

dev-ai: check build ## Start local dev server with Cloudflare Workers AI
	@$(WRANGLER) dev --assets "$(PUBLIC_DIR)" --port=$(DEV_PORT)

##@ Build
build: check ## Build the site (development)
	@sha=$$(git rev-parse HEAD) && HUGO_BUILD_SHA="$$sha" $(HUGO) $(HUGO_FLAGS) --destination "$(PUBLIC_DIR)"

postcss-build: check ## Run PostCSS + PurgeCSS (production CSS only)
	@HUGO_ENV=production NODE_ENV=production $(NPX) postcss assets/css/site.css -o assets/css/site.purged.css

build-prod: check postcss-build ## Build the site for production (with PurgeCSS)
	@sha=$$(git rev-parse HEAD) && HUGO_BUILD_SHA="$$sha" HUGO_ENV=production NODE_ENV=production $(HUGO) $(HUGO_FLAGS) --destination "$(PUBLIC_DIR)"

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

deps: check-node ## Install Node dependencies from the lockfile (skipped when node_modules matches the lockfile and Node ABI)
	@stamp=$$($(NODE) -e "const c=require('crypto'),f=require('fs');process.stdout.write(process.versions.modules+' '+c.createHash('sha256').update(f.readFileSync('package-lock.json')).digest('hex'))"); \
	if [ "$$(cat node_modules/.deps-stamp 2>/dev/null)" = "$$stamp" ]; then \
		echo "Dependencies up to date"; \
	else \
		$(NPM) ci --no-fund && echo "$$stamp" > node_modules/.deps-stamp; \
	fi

##@ Test & Audit
test: check ## Run the complete offline unit suite
	@$(NODE) --test --test-timeout=30000 --test-reporter=$(TEST_REPORTER) tests/unit/*.test.mjs

test-layouts: check ## Build Hugo fixtures and validate schema, public index, preloads and theme settings
	@$(NODE) --test --test-timeout=120000 --test-reporter=$(TEST_REPORTER) tests/integration/layouts.test.mjs

lint: check-node ## Lint all JavaScript with ESLint
	@$(NPX) eslint . --max-warnings=0

typecheck: check-node ## Type-check JavaScript (JSDoc, checkJs) for the Worker, scripts and browser code
	@$(NPX) tsc -p tsconfig.json
	@$(NPX) tsc -p tsconfig.scripts.json
	@$(NPX) tsc -p tsconfig.browser.json

lint-fix: check-node ## Apply safe ESLint fixes
	@$(NPX) eslint . --max-warnings=0 --fix

format: check-node ## Format JavaScript, source CSS and YAML (no Hugo content/templates)
	@$(NPX) prettier --write $(PRETTIER_FILES)

format-check: check-node ## Check formatting without edits
	@$(NPX) prettier --check $(PRETTIER_FILES)

lint-workflows: ## Validate GitHub Actions with the pinned actionlint release
	@command -v $(ACTIONLINT) >/dev/null || { \
		echo "Missing actionlint; run: make install-actionlint"; \
		echo "Then add $(ACTIONLINT_BIN_DIR) to PATH or set ACTIONLINT=/path/to/actionlint"; \
		exit 1; \
	}
	@$(ACTIONLINT)

install-actionlint: ## Install the pinned actionlint release binary (checksum-verified; no Go needed)
	@if [ -x "$(ACTIONLINT_BIN_DIR)/actionlint" ] && [ "$$("$(ACTIONLINT_BIN_DIR)/actionlint" -version | head -1)" = "$(ACTIONLINT_NUMBER)" ]; then \
		echo "actionlint $(ACTIONLINT_NUMBER) already installed in $(ACTIONLINT_BIN_DIR)"; \
	else \
		tmp=$$(mktemp -d) && \
		base="https://github.com/rhysd/actionlint/releases/download/$(ACTIONLINT_VERSION)" && \
		file="actionlint_$(ACTIONLINT_NUMBER)_$(ACTIONLINT_OS)_$(ACTIONLINT_ARCH).tar.gz" && \
		curl --fail --silent --show-error --location -o "$$tmp/$$file" "$$base/$$file" && \
		curl --fail --silent --show-error --location -o "$$tmp/checksums.txt" "$$base/actionlint_$(ACTIONLINT_NUMBER)_checksums.txt" && \
		(cd "$$tmp" && grep -F " $$file" checksums.txt | shasum -a 256 -c -) && \
		tar -xzf "$$tmp/$$file" -C "$$tmp" actionlint && \
		mkdir -p "$(ACTIONLINT_BIN_DIR)" && \
		install -m 0755 "$$tmp/actionlint" "$(ACTIONLINT_BIN_DIR)/actionlint" && \
		rm -rf "$$tmp" && \
		echo "installed actionlint $(ACTIONLINT_NUMBER) to $(ACTIONLINT_BIN_DIR)"; \
	fi

print-%: ## Print a Makefile variable (used by CI to read pinned versions)
	@echo '$($*)'

coverage: check-node ## Run offline tests with coverage (reports: COVERAGE_REPORTERS, default text-summary html lcov)
	@$(NODE) node_modules/c8/bin/c8.js $(addprefix --reporter=,$(COVERAGE_REPORTERS)) $(NODE) --test --test-timeout=30000 --test-reporter=$(TEST_REPORTER) tests/unit/*.test.mjs

audit-content: check-node ## Validate content front matter coverage (install dependencies first)
	@REPORT_DIR="$(REPORT_DIR)" $(NODE) scripts/audit_content.mjs

audit-urls: check-node ## Check external links (install dependencies first)
	@find content -name "*.md" -print0 | xargs -0 -r ./node_modules/.bin/markdown-link-check --config .markdown-link-check.json --quiet

audit-site: audit-content audit-urls ## Run all content and link audits

audit-rag: check-node ## Audit RAG prompt coverage, provenance and authoring gaps (offline)
	@$(NODE) scripts/audit_rag.mjs

##@ AI
ai-models: check-node ## List model aliases, parameters and dated prices (offline)
	@$(NODE) scripts/ai-eval.mjs models

ai-plan: check ## Validate corpus and write candidate manifest (offline)
	@$(NODE) scripts/generate_embeddings.mjs --check --manifest "$$REPORT_DIR/ai-corpus.json"

ai-check: check ## Validate corpus IDs, model selection and evaluation labels (offline)
	@$(NODE) scripts/generate_embeddings.mjs --check
	@$(NODE) scripts/ai-eval.mjs validate --models "$$AI_MODELS" --fixture "$$AI_FIXTURE"

ai-build: check-node ## Bundle the Worker locally (dry run: no credentials, no deployment)
	@mkdir -p "$$REPORT_DIR/empty-assets"
	@$(WRANGLER) deploy --dry-run --assets "$$REPORT_DIR/empty-assets" --outdir "$$REPORT_DIR/worker" >/dev/null

ai-embeddings: check check-env check-ns ## Ingest explicit candidate namespace (paid API; no activation/deletion)
	@$(NODE) scripts/generate_embeddings.mjs --namespace "$$AI_NAMESPACE" --manifest "$$REPORT_DIR/ai-corpus.json"

ai-refresh: check check-env ## Index changed corpus and set namespace (force: AI_REFRESH_FLAGS=--force)
	@$(NODE) scripts/refresh_ai_corpus.mjs $(AI_REFRESH_FLAGS)

ai-retrieval-eval: check check-env check-ns ## Evaluate live hit@k against labeled sources (paid API)
	@$(NODE) scripts/ai-eval.mjs retrieval --namespace "$$AI_NAMESPACE" --fixture "$$AI_FIXTURE" \
		--min-hit-rate "$$AI_MIN_HIT_RATE" --timeout-ms "$$AI_TIMEOUT_MS" --output "$$AI_RETRIEVAL_REPORT"

ai-compare: check check-env ## Compare models using identical labeled-source contexts (paid API)
	@$(NODE) scripts/ai-eval.mjs compare --models "$$AI_MODELS" --fixture "$$AI_FIXTURE" \
		--repeats "$$AI_REPEATS" --timeout-ms "$$AI_TIMEOUT_MS" --output "$$AI_COMPARISON_REPORT"

ai-compare-rag: check check-env check-ns ## Compare models using a validated live retrieval report (paid API)
	@$(NODE) scripts/ai-eval.mjs compare --namespace "$$AI_NAMESPACE" --models "$$AI_MODELS" \
		--fixture "$$AI_FIXTURE" --retrieval-report "$$AI_RETRIEVAL_REPORT" --min-hit-rate "$$AI_MIN_HIT_RATE" \
		--repeats "$$AI_REPEATS" --timeout-ms "$$AI_TIMEOUT_MS" --output "$$AI_COMPARISON_REPORT"

ai-release-check: check check-ns ## Gate activation using retrieval/model reports and Wrangler settings (offline)
	@$(NODE) scripts/ai-eval.mjs release-check --namespace "$$AI_NAMESPACE" --fixture "$$AI_FIXTURE" \
		--retrieval-report "$$AI_RETRIEVAL_REPORT" --comparison-report "$$AI_COMPARISON_REPORT" \
		--min-hit-rate "$$AI_MIN_HIT_RATE" --min-answer-rate "$$AI_MIN_ANSWER_RATE"

deploy-ai: ## Run offline checks and candidate release gate before deployment
	@$(MAKE) --no-print-directory ai-check test
	@$(MAKE) --no-print-directory ai-release-check
	@$(MAKE) --no-print-directory ai-build
	@$(MAKE) --no-print-directory deploy

##@ Deploy
deploy: build-prod ## Build (prod) and deploy the Worker with its static assets
	@$(MAKE) --no-print-directory deploy-built

deploy-built: check check-env ## Deploy an already validated production build (no rebuild)
	@test -f "$(PUBLIC_DIR)/index.html" || { echo "Missing site build; run make build-prod first"; exit 1; }
	@COMMIT_HASH=$$(git rev-parse HEAD); \
	COMMIT_MESSAGE=$$(printf '%.100s' "$$(git log -1 --pretty=%s)"); \
	$(WRANGLER) deploy --name "$(WORKER_NAME)" --assets "$(PUBLIC_DIR)" \
		--var DEPLOY_COMMIT:$$COMMIT_HASH \
		--message "$$COMMIT_MESSAGE"

deploy-needed: check-node check-env ## Print deploy=true|false: whether deployable files changed since the live Worker's commit
	@$(NODE) scripts/deploy_needed.mjs

cleanup-vectors: check-node check-env ## Retain the live corpus and the previous one; delete older versioned vectors
	@$(NODE) scripts/cleanup_vectors.mjs

cutover-domains: check-node check-env ## One-time: move the Pages custom domains to the Worker (ZONE=example.com, optional DRY_RUN=1)
	@test -n "$(ZONE)" || { echo "Set ZONE, for example make cutover-domains ZONE=samsongama.com"; exit 1; }
	@$(NODE) scripts/cutover_domains.mjs --zone "$(ZONE)" $(if $(DRY_RUN),--dry-run)

csp-headers: check ## Generate public/_headers CSP from a fresh build (run after make build-prod)
	@$(NODE) scripts/generate_csp.mjs

##@ CI
ci-check: lint-workflows lint typecheck format-check coverage ai-check ai-build build-prod test-layouts ## Run independent offline checks (use -j2 --output-sync=target)

ci: ## Run checks, refresh embeddings and deploy the matching chat corpus
	@$(MAKE) --no-print-directory --jobs=2 --output-sync=target ci-check audit-site
	@$(MAKE) --no-print-directory ai-refresh
	@$(MAKE) --no-print-directory deploy-built
