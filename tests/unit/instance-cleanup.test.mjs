import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupInstances, main } from '../../scripts/cleanup_instances.mjs';
import { createMaintenanceClient } from '../../scripts/lib/corpus-deployment.mjs';
import { activeWorker } from '../../scripts/lib/worker-deployment.mjs';
import { aiSearchMock } from '../helpers/ai-search.mjs';

const id = (letter) => `portfolio-${letter.repeat(12)}`;
const [LIVE, PREVIOUS, OLD, OLDER] = [id('a'), id('b'), id('c'), id('d')];

/** Live and previous instances, two older ones, and instances this pipeline does not own. */
function fixture(vars = { AI_SEARCH_INSTANCE: LIVE, AI_PREVIOUS_SEARCH_INSTANCE: PREVIOUS }) {
    const mock = aiSearchMock({
        vars,
        instances: { [OLDER]: [], [OLD]: [], [PREVIOUS]: [], [LIVE]: [], 'portfolio-notes': [], 'portfolio-legacy-index': [], foreign: [] },
    });
    return { mock, client: createMaintenanceClient('token', mock.fetchImpl), accountId: 'account' };
}
const deletes = (mock) => mock.requests.filter(({ method }) => method === 'DELETE').map(({ pathname }) => pathname.split('/').at(-1));

test('a dry run reports the plan without any write', async () => {
    const f = fixture();
    const messages = [];
    const result = await cleanupInstances({ ...f, dryRun: true, progress: (message) => messages.push(message) });
    assert.deepEqual(result, { dryRun: true, liveInstance: LIVE, removedInstances: 2 });
    assert.deepEqual(deletes(f.mock), []);
    assert.match(messages[0], /2 stale/);
});

test('a rejected delete stops cleanup and never deletes outside the stale instances', async () => {
    const f = fixture();
    const base = f.mock.fetchImpl;
    let attempts = 0;
    const client = createMaintenanceClient('token', async (url, init) => {
        if (new Request(url, init).method === 'DELETE' && ++attempts === 2) return Response.json({ success: false }, { status: 400 });
        return base(url, init);
    });
    await assert.rejects(cleanupInstances({ client, accountId: 'account' }), /400/);
    assert.deepEqual(
        [...f.mock.store.keys()].sort(),
        [LIVE, PREVIOUS, OLD, OLDER, 'foreign', 'portfolio-legacy-index', 'portfolio-notes'].sort().filter((key) => key !== deletes(f.mock)[0]),
    );
});

test('cleanup refuses without a live instance and stops if a deploy changes it mid-run', async () => {
    for (const vars of [null, {}, { AI_PREVIOUS_SEARCH_INSTANCE: PREVIOUS }]) {
        const f = fixture(vars);
        await assert.rejects(cleanupInstances(f), /Cannot determine the live AI Search instance/);
        assert.deepEqual(deletes(f.mock), []);
    }
    const f = fixture();
    const base = f.mock.fetchImpl;
    const client = createMaintenanceClient('token', async (url, init) => {
        const response = await base(url, init);
        // A deploy lands right after the first deletion.
        if (new Request(url, init).method === 'DELETE') f.mock.vars = { AI_SEARCH_INSTANCE: OLD, AI_PREVIOUS_SEARCH_INSTANCE: LIVE };
        return response;
    });
    await assert.rejects(cleanupInstances({ client, accountId: 'account' }), /changed during cleanup/);
    assert.equal(deletes(f.mock).length, 1);
});

test('prunes every versioned instance except live and previous, using the documented requests', async () => {
    const f = fixture();
    const result = await cleanupInstances(f);
    assert.deepEqual(result, { dryRun: false, liveInstance: LIVE, removedInstances: 2 });
    assert.deepEqual(deletes(f.mock).sort(), [OLD, OLDER].sort());
    assert.deepEqual([...f.mock.store.keys()].sort(), [LIVE, PREVIOUS, 'foreign', 'portfolio-legacy-index', 'portfolio-notes'].sort());
    assert.ok(f.mock.requests.every(({ pathname }) => !pathname.includes('vectorize')));
    assert.ok(f.mock.requests.some(({ method, pathname }) => method === 'GET' && pathname.endsWith('/ai-search/namespaces/default/instances')));
    const again = await cleanupInstances(f);
    assert.equal(again.removedInstances, 0, 'reruns are idempotent');
});

test('the CLI rejects unknown options and missing credentials before any request', async (t) => {
    const env = { ...process.env };
    t.after(() => {
        process.env = env;
    });
    process.env.CLOUDFLARE_ACCOUNT_ID = '';
    process.env.CLOUDFLARE_API_TOKEN = '';
    const fetchImpl = async () => assert.fail('Unexpected network request');
    await assert.rejects(main(['--invalid'], { fetchImpl }), /Unknown option/);
    await assert.rejects(main([], { fetchImpl }), /Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN/);
});

test('the live Worker lookup reads plain-text variables, treats a missing Worker as not deployed, and rejects a bad instance', async () => {
    const get = (impl) => ({ workers: { scripts: { scriptAndVersionSettings: { get: impl } } } });
    const bindings = [
        { type: 'plain_text', name: 'AI_SEARCH_INSTANCE', text: LIVE },
        { type: 'plain_text', name: 'DEPLOY_COMMIT', text: 'f'.repeat(40) },
        { type: 'secret_text', name: 'AI_SEARCH_INSTANCE', text: 'ignored' },
    ];
    assert.deepEqual(
        await activeWorker(
            get(async () => ({ bindings })),
            'account',
        ),
        { instance: LIVE, commit: 'f'.repeat(40) },
    );
    assert.deepEqual(
        await activeWorker(
            get(async () => ({ bindings: [...bindings, { type: 'plain_text', name: 'AI_PREVIOUS_SEARCH_INSTANCE', text: PREVIOUS }] })),
            'account',
        ),
        { instance: LIVE, previousInstance: PREVIOUS, commit: 'f'.repeat(40) },
    );
    assert.equal(
        await activeWorker(
            get(async () => Promise.reject(Object.assign(new Error('missing'), { status: 404 }))),
            'account',
        ),
        null,
    );
    for (const name of ['AI_SEARCH_INSTANCE', 'AI_PREVIOUS_SEARCH_INSTANCE']) {
        await assert.rejects(
            activeWorker(
                get(async () => ({ bindings: [{ type: 'plain_text', name, text: 'bad' }] })),
                'account',
            ),
            /Invalid .*AI Search instance/,
        );
    }
});
