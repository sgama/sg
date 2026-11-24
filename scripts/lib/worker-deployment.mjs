import { VERSIONED_INSTANCE } from './corpus-contract.mjs';

/**
 * What the live Worker was deployed with, read from its plain-text variables: the AI Search instance it queries, the
 * previous instance it replaced, and the commit it was built from. Returns null when the Worker has not been deployed yet.
 * @param {import('cloudflare').Cloudflare} client
 * @param {string} accountId
 * @param {string} [worker]
 * @returns {Promise<{ instance?: string, previousInstance?: string, commit?: string } | null>}
 */
export async function activeWorker(client, accountId, worker = 'sg') {
    let settings;
    try {
        settings = await client.workers.scripts.scriptAndVersionSettings.get(worker, { account_id: accountId });
    } catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 404) return null;
        throw error;
    }
    const vars = Object.fromEntries(
        (settings.bindings ?? []).filter((binding) => binding.type === 'plain_text').map((binding) => [binding.name, binding.text]),
    );
    if (vars.AI_SEARCH_INSTANCE !== undefined && !VERSIONED_INSTANCE.test(vars.AI_SEARCH_INSTANCE))
        throw new Error('Invalid active AI Search instance');
    if (vars.AI_PREVIOUS_SEARCH_INSTANCE !== undefined && !VERSIONED_INSTANCE.test(vars.AI_PREVIOUS_SEARCH_INSTANCE))
        throw new Error('Invalid previous AI Search instance');
    /** @type {{ instance?: string, previousInstance?: string, commit?: string }} */
    const active = { instance: vars.AI_SEARCH_INSTANCE, commit: vars.DEPLOY_COMMIT };
    if (vars.AI_PREVIOUS_SEARCH_INSTANCE !== undefined) active.previousInstance = vars.AI_PREVIOUS_SEARCH_INSTANCE;
    return active;
}
