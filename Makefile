SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help
MAKEFLAGS += --no-builtin-rules

.PHONY: help check check-node check-env check-instance csp-headers \
	serve dev-ai build build-prod clean \
	deps test test-layouts lint lint-fix typecheck format format-check typos lint-workflows install-actionlint coverage \
	audit-content audit-urls audit-site audit-rag \
	ai-plan ai-check ai-build ai-ingest ai-refresh ai-eval ai-audit deploy-ai \
	deploy deploy-built deploy-needed cleanup-instances cutover-domains ci-check

ifneq (,$(wildcard .env))
include .env
export
endif

# ── Config ─────────────────────────────────────────────────────────────────────
WORKER_NAME       ?= sg
PUBLIC_DIR        ?= public
DEV_PORT          ?= 8788
REPORT_DIR        ?= reports
AI_REFRESH_FLAGS  ?=
AI_FIXTURE        ?= tests/fixtures/ai-eval.json
AI_PASS_RATE      ?= 90
HUGO              ?= hugo
HUGO_FLAGS        ?= --minify --cleanDestinationDir
HUGO_SERVER_FLAGS ?=
NODE              ?= node
BUILD_SHA          = $(shell git rev-parse HEAD)
UNIT_TESTS         = $(NODE) --test --test-timeout=30000 --test-reporter=$(TEST_REPORTER) tests/unit/*.test.mjs
COVERAGE_REPORTERS ?= text-summary html lcov
PRETTIER_FILES    := "assets/js/**/*.js" "functions/**/*.js" "shared/**/*.js" "scripts/**/*.mjs" "evals/**/*.mjs" "tests/**/*.mjs" "*.config.js" "assets/css/**/*.css" "*.{yml,yaml}" ".*.{yml,yaml}" "data/**/*.{yml,yaml}" ".github/**/*.{yml,yaml}"
NPM               ?= npm
NPX               ?= npx --no-install
WRANGLER          ?= npx wrangler
TEST_REPORTER     ?= spec
ACTIONLINT        ?= actionlint
TYPOS             ?= typos
ACTIONLINT_VERSION := v1.7.7
ACTIONLINT_NUMBER := $(patsubst v%,%,$(ACTIONLINT_VERSION))
ACTIONLINT_OS     := $(shell uname -s | tr '[:upper:]' '[:lower:]')
ACTIONLINT_ARCH   := $(shell uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
ACTIONLINT_BIN_DIR ?= $(HOME)/.local/bin

export WORKER_NAME PUBLIC_DIR REPORT_DIR
export AI_REFRESH_FLAGS AI_FIXTURE AI_PASS_RATE
export HUGO NODE

# ── Guards ─────────────────────────────────────────────────────────────────────
check: check-node ## Verify hugo/node/npm (node 22+ required by wrangler)
	@command -v $(HUGO) >/dev/null || { echo "Missing hugo"; exit 1; }

check-node: ## Verify node/npm (no Hugo required)
	@command -v $(NODE) >/dev/null || { echo "Missing node"; exit 1; }
	@command -v $(NPM) >/dev/null || { echo "Missing npm"; exit 1; }
	@$(NODE) -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22+ required"); process.exit(1); }'

check-env: ## Verify Cloudflare credentials are set
	@test -n "$${CLOUDFLARE_ACCOUNT_ID:-}" || (echo "Missing CLOUDFLARE_ACCOUNT_ID" && exit 1)
	@test -n "$${CLOUDFLARE_API_TOKEN:-}"  || (echo "Missing CLOUDFLARE_API_TOKEN"  && exit 1)

check-instance:
	@test -n "$${AI_INSTANCE:-}" || { echo "Set AI_INSTANCE to the candidate instance printed by make ai-plan"; exit 1; }

# ── Help ───────────────────────────────────────────────────────────────────────
help: ## Show available targets
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)

##@ Development
serve: check ## Start Hugo development server
	@HUGO_BUILD_SHA="$(BUILD_SHA)" $(HUGO) server $(HUGO_SERVER_FLAGS)

dev-ai: check build ## Start local dev server with Cloudflare Workers AI
	@$(WRANGLER) dev --assets "$(PUBLIC_DIR)" --port=$(DEV_PORT)

##@ Build
build: check ## Build the site (development)
	@HUGO_BUILD_SHA="$(BUILD_SHA)" $(HUGO) $(HUGO_FLAGS) --destination "$(PUBLIC_DIR)"

build-prod: check ## Build the site for production
	@HUGO_BUILD_SHA="$(BUILD_SHA)" HUGO_ENV=production NODE_ENV=production $(HUGO) $(HUGO_FLAGS) --destination "$(PUBLIC_DIR)"

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
	@$(UNIT_TESTS)

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

typos: ## Check spelling across the repository with typos
	@command -v $(TYPOS) >/dev/null || { echo "Missing typos; install typos-cli or set TYPOS=/path/to/typos"; exit 1; }
	@$(TYPOS)

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
	@$(NODE) node_modules/c8/bin/c8.js $(addprefix --reporter=,$(COVERAGE_REPORTERS)) $(UNIT_TESTS)

audit-content: check-node ## Validate content front matter coverage (install dependencies first)
	@REPORT_DIR="$(REPORT_DIR)" $(NODE) scripts/audit_content.mjs

audit-urls: check-node ## Check external links (install dependencies first)
	@find content -name "*.md" -print0 | xargs -0 -r ./node_modules/.bin/markdown-link-check --config .markdown-link-check.json --quiet

audit-site: audit-content audit-urls ## Run all content and link audits

audit-rag: check-node ## Audit RAG prompt coverage, provenance and authoring gaps (offline)
	@$(NODE) scripts/audit_rag.mjs

##@ AI
ai-plan: check ## Validate corpus and write candidate manifest (offline)
	@$(NODE) scripts/ingest_corpus.mjs --check --manifest "$$REPORT_DIR/ai-corpus.json"

ai-check: check ## Validate corpus items and evaluation labels (offline)
	@$(NODE) scripts/ingest_corpus.mjs --check
	@$(NODE) scripts/validate_ai_fixture.mjs

ai-build: check-node ## Bundle the Worker locally (dry run: no credentials, no deployment)
	@mkdir -p "$$REPORT_DIR/empty-assets"
	@$(WRANGLER) deploy --dry-run --assets "$$REPORT_DIR/empty-assets" --outdir "$$REPORT_DIR/worker" >/dev/null

ai-ingest: check check-env check-instance ## Create and index the explicit candidate AI Search instance (paid API; no activation/deletion)
	@$(NODE) scripts/ingest_corpus.mjs --instance "$$AI_INSTANCE" --manifest "$$REPORT_DIR/ai-corpus.json"

ai-refresh: check check-env ## Index changed corpus and set the live instance (force: AI_REFRESH_FLAGS=--force)
	@$(NODE) scripts/refresh_ai_corpus.mjs $(AI_REFRESH_FLAGS)

ai-eval: check check-env check-instance ## Evaluate retrieval and answers with promptfoo (paid; gate: AI_PASS_RATE %)
	@PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_PASS_RATE_THRESHOLD="$$AI_PASS_RATE" \
		$(NPX) promptfoo eval -c evals/promptfooconfig.yaml --no-cache --no-share -o "$$REPORT_DIR/ai-eval.json"; \
	status=$$?; $(NODE) scripts/summarize_ai_eval.mjs "$$REPORT_DIR/ai-eval.json"; exit $$status

ai-audit: ai-ingest ai-eval ## Ingest candidate instance then evaluate it (paid)

deploy-ai: ## Run offline checks and the live evaluation gate before deployment
	@$(MAKE) --no-print-directory ai-check test
	@$(MAKE) --no-print-directory ai-eval
	@$(MAKE) --no-print-directory ai-build
	@$(MAKE) --no-print-directory deploy

##@ Deploy
deploy: build-prod ## Build (prod) and deploy the Worker with its static assets
	@$(MAKE) --no-print-directory csp-headers
	@$(MAKE) --no-print-directory deploy-built

deploy-built: check check-env ## Deploy an already validated production build (no rebuild)
	@test -f "$(PUBLIC_DIR)/index.html" || { echo "Missing site build; run make build-prod first"; exit 1; }
	@grep -Eq '^AI_SEARCH_INSTANCE = "portfolio-[a-f0-9]{12}"$$' wrangler.toml || \
		{ echo "Missing AI_SEARCH_INSTANCE in wrangler.toml; run make ai-refresh first"; exit 1; }
	@COMMIT_HASH=$$(git rev-parse HEAD); \
	COMMIT_MESSAGE=$$(printf '%.100s' "$$(git log -1 --pretty=%s)"); \
	$(WRANGLER) deploy --name "$(WORKER_NAME)" --assets "$(PUBLIC_DIR)" \
		--var DEPLOY_COMMIT:$$COMMIT_HASH \
		--message "$$COMMIT_MESSAGE"

deploy-needed: check-node check-env ## Print deploy=true|false: whether deployable files changed since the live Worker's commit
	@$(NODE) scripts/deploy_needed.mjs

cleanup-instances: check-node check-env ## Retain the live AI Search instance and the previous one; delete older versioned instances
	@$(NODE) scripts/cleanup_instances.mjs

cutover-domains: check-node check-env ## One-time: move the Pages custom domains to the Worker (ZONE=example.com, optional DRY_RUN=1)
	@test -n "$(ZONE)" || { echo "Set ZONE, for example make cutover-domains ZONE=samsongama.com"; exit 1; }
	@$(NODE) scripts/cutover_domains.mjs --zone "$(ZONE)" $(if $(DRY_RUN),--dry-run)

csp-headers: check ## Generate public/_headers CSP from a fresh build (run after make build-prod)
	@$(NODE) scripts/generate_csp.mjs

##@ CI
ci-check: lint-workflows lint typecheck format-check coverage ai-check ai-build build-prod test-layouts ## Run independent offline checks (use -j4 --output-sync=target)
