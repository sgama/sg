// The Worker's bindings (see wrangler.toml). `AI` is typed loosely on purpose: model IDs are configuration, not literals.
interface Env {
    AI: { run(model: string, input: object): Promise<any> };
    VECTORIZE_INDEX: Vectorize;
    CHAT_LOGS?: KVNamespace;
    AI_MODEL?: string;
    AI_CORPUS_NAMESPACE?: string;
    // The commit this version was deployed from (set by `make deploy-built`).
    DEPLOY_COMMIT?: string;
}
