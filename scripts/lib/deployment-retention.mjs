// Pure deployment-retention planning. No I/O: callers supply the inventory.
export const VERSIONED_NAMESPACE = /^corpus-[a-f0-9]{56}$/;
const successful = (deployment) =>
    !deployment.is_skipped && deployment.latest_stage?.name === 'deploy' && deployment.latest_stage.status === 'success';

export function planRetention(deployments, activeId, branch, previous = 5) {
    if (!activeId || !deployments.some((deployment) => deployment.id === activeId)) {
        throw new Error('Active deployment must be present before cleanup');
    }
    if (!Number.isInteger(previous) || previous < 0) throw new Error('Invalid deployment retention count');
    if (deployments.some((deployment) => !deployment.id || !Number.isFinite(Date.parse(deployment.created_on)))) {
        throw new Error('Deployment inventory contains invalid IDs or timestamps');
    }
    const production = deployments.filter(
        (deployment) => deployment.environment === 'production' && deployment.deployment_trigger?.metadata?.branch === branch,
    );
    const active = deployments.find((deployment) => deployment.id === activeId);
    if (active.environment !== 'production') {
        throw new Error('Active deployment is not production; refusing cleanup');
    }
    const predecessors = production
        .filter(
            (deployment) => deployment.id !== activeId && Date.parse(deployment.created_on) < Date.parse(active.created_on) && successful(deployment),
        )
        .sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))
        .slice(0, previous);
    const keep = new Set([activeId, ...predecessors.map((deployment) => deployment.id)]);
    // Production builds in progress survive; previews are removed regardless of status.
    const remove = deployments.filter(
        (deployment) =>
            deployment.environment === 'preview' ||
            (production.some((item) => item.id === deployment.id) &&
                !keep.has(deployment.id) &&
                ['success', 'failure', 'canceled'].includes(deployment.latest_stage?.status)),
    );
    return {
        remove,
        retain: deployments.filter((deployment) => !remove.some((item) => item.id === deployment.id)),
    };
}

export function referencedNamespaces(deployments) {
    const namespaces = new Set();
    for (const deployment of deployments) {
        const setting = deployment.env_vars?.AI_CORPUS_NAMESPACE;
        if (setting?.type !== 'plain_text' || !VERSIONED_NAMESPACE.test(setting.value)) {
            throw new Error(`Cannot determine corpus namespace for retained deployment ${deployment.id}; refusing vector cleanup`);
        }
        namespaces.add(setting.value);
    }
    return namespaces;
}
