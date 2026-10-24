import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireCloudflareCredentials } from './lib/cloudflare-ai.mjs';
import { createMaintenanceClient } from './lib/corpus-deployment.mjs';
import { activeWorker } from './lib/worker-deployment.mjs';
import { runIfMain } from './lib/cli.mjs';

const run = promisify(execFile);

// Everything that can change what is built, indexed or deployed. Tests, docs and CI configuration are deliberately
// absent: a change there cannot alter the site, so it does not need a new deployment. Dependency changes show up in
// package-lock.json, and the Makefile is mostly lint and CI targets, so neither it nor package.json is listed. To force a
// deploy, touch any listed file.
export const DEPLOY_INPUTS = [
    'assets',
    'content',
    'data',
    'functions',
    'layouts',
    'static',
    'scripts/lib',
    'scripts/generate_csp.mjs',
    'scripts/generate_embeddings.mjs',
    'scripts/refresh_ai_corpus.mjs',
    'config.toml',
    'go.mod',
    'go.sum',
    'package-lock.json',
    'postcss.config.js',
    'wrangler.toml',
];

const git = async (args) => (await run('git', args, { maxBuffer: 10 * 1024 * 1024 })).stdout;

/**
 * Whether a new deployment is needed: true unless no deployable file changed since the commit the active production
 * deployment was built from. Any doubt (no recorded commit, commit not available, git failure) means deploy.
 */
export async function deployNeeded({ client, accountId, worker = 'sg', exec = git, inputs = DEPLOY_INPUTS }) {
    const active = await activeWorker(client, accountId, worker);
    if (!active) return { needed: true, reason: 'the Worker has not been deployed yet' };
    const commit = active.commit;
    if (!/^[0-9a-f]{40}$/.test(commit ?? '')) return { needed: true, reason: 'the live Worker has no recorded commit' };
    try {
        await exec(['cat-file', '-e', `${commit}^{commit}`]);
    } catch {
        // A shallow checkout lacks older commits; fetching one commit is enough to compare trees.
        try {
            await exec(['fetch', '--depth=1', 'origin', commit]);
        } catch {
            return { needed: true, reason: `commit ${commit.slice(0, 7)} is not available to compare` };
        }
    }
    const changed = (await exec(['diff', '--name-only', commit, 'HEAD', '--', ...inputs])).split('\n').filter(Boolean);
    return changed.length
        ? { needed: true, reason: `${changed.length} deployable file(s) changed since ${commit.slice(0, 7)}: ${changed.slice(0, 5).join(', ')}` }
        : { needed: false, reason: `no deployable file changed since the live Worker (${commit.slice(0, 7)})` };
}

/** Prints `deploy=true|false` for GITHUB_OUTPUT and the reason to stderr. Failures print `deploy=true`: never skip on doubt. */
export async function main({ fetchImpl = globalThis.fetch, exec = git } = {}) {
    let result;
    try {
        const { accountId, apiToken } = requireCloudflareCredentials();
        result = await deployNeeded({
            client: createMaintenanceClient(apiToken, fetchImpl),
            accountId,
            worker: process.env.WORKER_NAME ?? 'sg',
            exec,
        });
    } catch (error) {
        result = { needed: true, reason: `could not decide (${error.message})` };
    }
    console.error(`Deployment ${result.needed ? 'needed' : 'skipped'}: ${result.reason}`);
    console.log(`deploy=${result.needed}`);
}

runIfMain(import.meta.url, main, 'Deploy check failed');
