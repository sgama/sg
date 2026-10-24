export const VERSIONED_NAMESPACE = /^corpus-[a-f0-9]{56}$/;

/**
 * What the live Worker was deployed with, read from its plain-text variables: the corpus namespace it queries and the
 * commit it was built from. Returns null when the Worker has not been deployed yet.
 * @param {import('cloudflare').Cloudflare} client
 * @param {string} accountId
 * @param {string} [worker]
 * @returns {Promise<{ namespace?: string, commit?: string } | null>}
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
    return { namespace: vars.AI_CORPUS_NAMESPACE, commit: vars.DEPLOY_COMMIT };
}
