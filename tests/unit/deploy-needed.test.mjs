import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEPLOY_INPUTS, deployNeeded, main } from '../../scripts/deploy_needed.mjs';

const SHA = 'a'.repeat(40);
const root = fileURLToPath(new URL('../../', import.meta.url));

function client({ canonical = { id: 'active' }, metadata = { commit_hash: SHA } } = {}) {
    return {
        pages: {
            projects: {
                get: async () => ({ canonical_deployment: canonical }),
                deployments: { get: async () => ({ id: 'active', deployment_trigger: { metadata } }) },
            },
        },
    };
}

/** A scripted git: `has` says whether the commit is present, `fetchable` whether it can be fetched, `changed` the diff output. */
function git({ has = true, fetchable = true, changed = '' } = {}) {
    const calls = [];
    const exec = async (args) => {
        calls.push(args);
        if (args[0] === 'cat-file' && !has && !calls.some(([name]) => name === 'fetch' && fetchable)) throw new Error('missing');
        if (args[0] === 'fetch' && !fetchable) throw new Error('offline');
        return args[0] === 'diff' ? changed : '';
    };
    return { calls, exec };
}

test('a deployment is skipped only when no deployable file changed, and every doubt deploys', async () => {
    const decide = (clientOptions, gitOptions) => deployNeeded({ client: client(clientOptions), accountId: 'account', exec: git(gitOptions).exec });
    assert.deepEqual(await decide({ canonical: null }), { needed: true, reason: 'there is no active deployment' });
    assert.match((await decide({ metadata: {} })).reason, /no recorded commit/);
    assert.match((await decide({ metadata: { commit_hash: 'abc123' } })).reason, /no recorded commit/);
    assert.match((await decide({}, { has: false, fetchable: false })).reason, /not available/);

    const changed = await decide({}, { changed: 'content/a.md\nlayouts/b.html\n' });
    assert.equal(changed.needed, true);
    assert.match(changed.reason, /2 deployable file\(s\) changed.*content\/a\.md, layouts\/b\.html/);

    const unchanged = await decide({}, { changed: '' });
    assert.equal(unchanged.needed, false);
    assert.match(unchanged.reason, /no deployable file changed/);
});

test('a shallow checkout fetches the active commit once, and the diff covers exactly the deployable inputs', async () => {
    const { calls, exec } = git({ has: false });
    const result = await deployNeeded({ client: client(), accountId: 'account', exec });
    assert.equal(result.needed, false);
    assert.deepEqual(calls.at(-2), ['fetch', '--depth=1', 'origin', SHA]);
    assert.deepEqual(calls.at(-1), ['diff', '--name-only', SHA, 'HEAD', '--', ...DEPLOY_INPUTS]);
});

test('every deployable input path exists, so a rename cannot silently drop it from the list', () => {
    for (const input of DEPLOY_INPUTS) assert.ok(existsSync(root + input), input);
    for (const ignored of ['tests', 'docs', '.github', 'README.md', 'Makefile', 'package.json'])
        assert.ok(!DEPLOY_INPUTS.includes(ignored), `${ignored} must not trigger a deploy`);
});

test('the CLI prints deploy=true when it cannot decide, and deploy=false only on a clean comparison', async (t) => {
    const env = { ...process.env };
    t.after(() => {
        process.env = env;
    });
    const out = t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    delete process.env.CLOUDFLARE_API_TOKEN;
    await main();
    assert.equal(out.mock.calls.at(-1).arguments[0], 'deploy=true');
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account';
    process.env.CLOUDFLARE_API_TOKEN = 'token';
    await main({ fetchImpl: async () => new Response('rejected', { status: 400 }), exec: git().exec });
    assert.equal(out.mock.calls.at(-1).arguments[0], 'deploy=true');
});
