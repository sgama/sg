.PHONY: help build serve clean init update

# Default target
help: ## Show this help message
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

init: ## Initialize git submodules
	git submodule update --init --recursive

update: ## Update git submodules
	git submodule update --recursive --remote

serve: ## Start Hugo development server
	hugo server --gc --ignoreCache

dev-ai: build ## Start local server with AI Functions (requires Wrangler)
	npx wrangler pages dev public

build: ## Build the Hugo site
	hugo --gc --minify

clean: ## Clean generated files
	rm -rf public/

deploy: build ## Build and deploy (customize as needed)
	@echo "Build complete. Customize this target for your deployment method."

pre-commit: ## Run pre-commit hooks manually
	@pre-commit validate-config
	@pre-commit run --all-files --color auto
