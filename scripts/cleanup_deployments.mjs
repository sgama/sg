/**
 * Delete all Pages deployments for BRANCH except the most recent one.
 * Equivalent to the cleanup-deployments Make target but without jq/curl.
 *
 * Usage: node scripts/cleanup_deployments.mjs
 */
import Cloudflare from 'cloudflare';
import 'dotenv/config';

const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = process.env;
const PROJECT = process.env.PROJECT_NAME ?? 'sg';
const BRANCH  = process.env.BRANCH ?? 'develop';

if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    console.error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
    process.exit(1);
}

const cf = new Cloudflare({ apiToken: CLOUDFLARE_API_TOKEN });

const allDeployments = [];
for await (const d of cf.pages.projects.deployments.list(PROJECT, { account_id: CLOUDFLARE_ACCOUNT_ID })) {
    allDeployments.push(d);
}

const production = allDeployments
    .filter(d => (d.deployment_trigger?.metadata?.branch ?? '') === BRANCH)
    .filter(d => d.environment === 'production')
    .sort((a, b) => new Date(b.created_on) - new Date(a.created_on));

if (production.length === 0) {
    console.log(`No production deployments found for branch "${BRANCH}".`);
    process.exit(0);
}

const [keep, ...stale] = production;
console.log(`Keeping: ${keep.id} (${keep.created_on})`);

for (const d of stale) {
    await cf.pages.projects.deployments.delete(PROJECT, d.id, {
        account_id: CLOUDFLARE_ACCOUNT_ID,
    });
    console.log(`Deleted:  ${d.id} (${d.created_on})`);
}

console.log(`Done. Removed ${stale.length} stale deployment(s).`);
