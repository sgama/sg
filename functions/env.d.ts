// The Worker's bindings (see wrangler.toml).
interface Env {
    AI: Ai;
    AI_SEARCH: AiSearchNamespace;
    // The live AI Search instance, set by `make deploy-built` after `make ai-refresh` indexed this commit's corpus.
    AI_SEARCH_INSTANCE?: string;
    AI_MODEL?: string;
    AI_GATEWAY_ID?: string;
    CHAT_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    // The commit this version was deployed from (set by `make deploy-built`).
    DEPLOY_COMMIT?: string;
}
