// The Worker's bindings (see wrangler.toml). `AI` is typed loosely on purpose: model IDs are configuration, not literals.
interface Env {
    AI: { run(model: string, input: object, options?: { signal?: AbortSignal; gateway?: { id: string } }): Promise<any> };
    VECTORIZE_INDEX: Vectorize;
    AI_MODEL?: string;
    AI_GATEWAY_ID?: string;
    CHAT_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    AI_CORPUS_NAMESPACE?: string;
    // The commit this version was deployed from (set by `make deploy-built`).
    DEPLOY_COMMIT?: string;
}
