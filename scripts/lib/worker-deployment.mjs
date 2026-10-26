export const VERSIONED_NAMESPACE = /^corpus-[a-f0-9]{56}$/;

/**
 * What the live Worker was deployed with, read from its plain-text variables: the corpus namespace it queries, the
 * previous namespace it replaced, and the commit it was built from. Returns null when the Worker has not been deployed yet.
 * @param {import('cloudflare').Cloudflare} client
 * @param {string} accountId
 * @param {string} [worker]
 * @returns {Promise<{ namespace?: string, previousNamespace?: string, commit?: string } | null>}
 */
export async function activeWorker(client, accountId, worker = 'sg') {
    let settings;
    try {
        settings = await client.workers.scripts.scriptAndVersionSettings.get(worker, { account_id: accountId });
    } catch (error) {
        if (error?.status === 404) return null;
        throw error;
    }
    const vars = Object.fromEntries(
        (settings.bindings ?? []).filter((binding) => binding.type === 'plain_text').map((binding) => [binding.name, binding.text]),
    );
    if (vars.AI_CORPUS_NAMESPACE !== undefined && !VERSIONED_NAMESPACE.test(vars.AI_CORPUS_NAMESPACE))
        throw new Error('Invalid active corpus namespace');
    if (vars.AI_PREVIOUS_CORPUS_NAMESPACE !== undefined && !VERSIONED_NAMESPACE.test(vars.AI_PREVIOUS_CORPUS_NAMESPACE))
        throw new Error('Invalid previous corpus namespace');
    const active = { namespace: vars.AI_CORPUS_NAMESPACE, commit: vars.DEPLOY_COMMIT };
    if (vars.AI_PREVIOUS_CORPUS_NAMESPACE !== undefined) active.previousNamespace = vars.AI_PREVIOUS_CORPUS_NAMESPACE;
    return active;
}
