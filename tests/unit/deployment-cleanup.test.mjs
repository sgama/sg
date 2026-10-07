import { test } from 'node:test';
import assert from 'node:assert/strict';
import Cloudflare from 'cloudflare';
import { setImmediate } from 'node:timers/promises';
import { cleanupDeployments, planRetention, referencedNamespaces, main } from '../../scripts/cleanup_deployments.mjs';
import { createMaintenanceClient } from '../../scripts/lib/corpus-deployment.mjs';
import { AI_CONFIG } from '../../functions/_lib/application.js';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function retryTimers(t) {
    const retries = [];
    const setTimeout = globalThis.setTimeout;
    const timer = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
        if (delay !== 120000) return setTimeout(callback, delay, ...args);
        retries.push(() => callback(...args));
        return setTimeout(() => {}, 0);
    });
    t.after(() => timer.mock.restore());
    return {
        async waitForRetry(count) {
            for (let turn = 0; turn < 100; turn++) {
                if (retries.length >= count) return;
                await setImmediate();
            }
            assert.fail(`SDK did not schedule a 120-second delay for retry ${count}`);
        },
        resume(count) { retries[count - 1](); },
    };
}

test('a deployment created during inventory prevents cleanup', async () => {
    const data = fixture();
    const listVectors = data.client.vectorize.indexes.listVectors;
    data.client.vectorize.indexes.listVectors = async (...args) => {
        data.setDeployments(Array.from({ length: 9 }, (_, index) => deployment(index + 1)));
        return listVectors(...args);
    };
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }), /Deployment inventory changed/);
    assert.deepEqual(data.calls, []);
});

test('changed active deployment stops cleanup before writes', async () => {
    const data = fixture();
    const listVectors = data.client.vectorize.indexes.listVectors;
    data.client.vectorize.indexes.listVectors = async (...args) => {
        data.setActive('d7');
        return listVectors(...args);
    };
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }), /Active deployment changed/);
    assert.deepEqual(data.calls, []);
});

const namespace = number => `corpus-${number.toString(16).padStart(56, '0')}`;
const deployment = (number, overrides = {}) => ({
    id: `d${number}`,
    created_on: new Date(Date.UTC(2026, 0, number)).toISOString(),
    environment: 'production',
    deployment_trigger: { metadata: { branch: 'develop' } },
    latest_stage: { name: 'deploy', status: 'success' },
    env_vars: { AI_CORPUS_NAMESPACE: { type: 'plain_text', value: namespace(number) } },
    ...overrides,
});

test('cleanup CLI dry-run uses injected transport and reports without deletion', async (t) => {
    const env = { ...process.env };
    t.after(() => { process.env = env; });
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account';
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.PROJECT_NAME = 'test-project';
    process.env.BRANCH = 'develop';
    const output = t.mock.method(console, 'log', () => {});
    const paths = [];
    await main(['--dry-run'], { fetchImpl: async (url, init) => {
        const request = new Request(url, init);
        assert.equal(request.method, 'GET');
        const target = new URL(request.url);
        paths.push(target.pathname);
        const base = '/client/v4/accounts/account/pages/projects/test-project';
        let result;
        if (target.pathname === base) result = { canonical_deployment: { id: 'active' } };
        else if (target.pathname === `${base}/deployments`) {
            result = target.searchParams.has('page') ? [] : [active];
        } else if (target.pathname === `${base}/deployments/active`) result = active;
        else {
            assert.equal(target.pathname, '/client/v4/accounts/account/vectorize/v2/indexes/portfolio-index/list');
            result = { vectors: [], isTruncated: false };
        }
        return Response.json({ success: true, result });
    } });
    assert.deepEqual(JSON.parse(output.mock.calls[0].arguments[0]), {
        dryRun: true, retainedDeployments: ['active'], removedDeployments: [], removedVectors: 0,
    });
    assert.ok(paths.length > 1);
});

function fixture() {
    let deployments = Array.from({ length: 8 }, (_, index) => deployment(index + 1));
    const calls = [];
    let active = 'd8';
    const vectors = [
        { id: 'old', namespace: namespace(1) },
        { id: 'active', namespace: namespace(8) },
        { id: 'previous', namespace: namespace(3) },
        { id: 'candidate', namespace: namespace(99) },
        { id: 'legacy', namespace: '' },
    ];
    const client = {
        pages: { projects: {
            get: async () => ({ canonical_deployment: { id: active } }),
            deployments: {
                list: async function* () { yield* deployments; },
                get: async (id, params) => {
                    assert.deepEqual(params, { account_id: 'account', project_name: 'sg' });
                    return deployments.find(item => item.id === id);
                },
                delete: async (id, params) => {
                    const preview = deployments.find(item => item.id === id).environment === 'preview';
                    assert.deepEqual(params, { account_id: 'account', project_name: 'sg',
                        ...(preview ? { force: true } : {}) });
                    calls.push(['deployment', id]);
                    deployments = deployments.filter(item => item.id !== id);
                },
            },
        } },
        vectorize: { indexes: {
            listVectors: async (_, options) => options.cursor
                ? { vectors: vectors.slice(2).map(({ id }) => ({ id })), isTruncated: false }
                : { vectors: vectors.slice(0, 2).map(({ id }) => ({ id })), isTruncated: true, nextCursor: 'next' },
            getByIDs: async (_, options) => vectors.filter(vector => options.ids.includes(vector.id)),
            deleteByIDs: async (_, options) => { calls.push(['vectors', options.ids]); return { mutationId: 'deleted' }; },
        } },
    };
    return { client, calls, wait: async (_, __, id) => calls.push(['ready', id]),
        setDeployments: value => { deployments = value; }, setActive: value => { active = value; } };
}

test('cleanup CLI invalid options and missing credentials fail without network calls', async (t) => {
    const env = { ...process.env };
    t.after(() => { process.env = env; });
    process.env.CLOUDFLARE_ACCOUNT_ID = '';
    process.env.CLOUDFLARE_API_TOKEN = '';
    const fetchImpl = async () => assert.fail('Unexpected network request');
    await assert.rejects(main(['--invalid'], { fetchImpl }), /Unknown option/);
    await assert.rejects(main([], { fetchImpl }), /Missing Cloudflare credentials/);
    const root = await mkdtemp(path.join(os.tmpdir(), 'sg-cleanup-cli-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = spawnSync(process.execPath,
        [fileURLToPath(new URL('../../scripts/cleanup_deployments.mjs', import.meta.url))],
        { cwd: root, env: process.env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Deployment\/corpus cleanup failed: Missing Cloudflare credentials/);
});

test('deletes completed and in-progress previews before pruning their unreferenced vectors', async () => {
    const data = fixture();
    data.setDeployments([...Array.from({ length: 8 }, (_, index) => deployment(index + 1)),
        deployment(99, { environment: 'preview', env_vars: {} }),
        deployment(100, { environment: 'preview',
            latest_stage: { name: 'build', status: 'active' }, env_vars: {} })]);
    const result = await cleanupDeployments({ ...data, accountId: 'account' });
    assert.deepEqual(result.removedDeployments, ['d1', 'd2', 'd99', 'd100']);
    assert.deepEqual(data.calls, [
        ['deployment', 'd1'], ['deployment', 'd2'],
        ['deployment', 'd99'], ['deployment', 'd100'],
        ['vectors', ['old', 'candidate']], ['ready', 'deleted'],
    ]);
});

test('deletes deployments before unreferenced versioned vectors and waits for mutation', async () => {
    const data = fixture();
    const result = await cleanupDeployments({ ...data, accountId: 'account' });
    assert.deepEqual(result.removedDeployments, ['d1', 'd2']);
    assert.equal(result.retainedDeployments.length, 6);
    assert.equal(result.removedVectors, 2);
    assert.deepEqual(data.calls, [
        ['deployment', 'd1'], ['deployment', 'd2'],
        ['vectors', ['old', 'candidate']], ['ready', 'deleted'],
    ]);
});

test('dry run makes no destructive calls', async () => {
    const data = fixture();
    const result = await cleanupDeployments({ ...data, accountId: 'account', dryRun: true });
    assert.equal(result.removedVectors, 2);
    assert.deepEqual(data.calls, []);
});

test('failed deployment deletion prevents all vector deletion', async () => {
    const data = fixture();
    data.client.pages.projects.deployments.delete = async () => { throw new Error('Delete failed'); };
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }), /Delete failed/);
    assert.deepEqual(data.calls, []);
});

test('incomplete deployment metadata blocks destructive cleanup', () => {
    assert.throws(() => planRetention([], 'missing', 'develop'), /Active deployment/);
    assert.throws(() => referencedNamespaces([deployment(1, { env_vars: {} })]), /refusing vector cleanup/);
});

test('incomplete vector fetch prevents deployment deletion', async () => {
    const data = fixture();
    data.client.vectorize.indexes.getByIDs = async () => [];
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }), /Incomplete vector records/);
    assert.deepEqual(data.calls, []);
});

test('invalid retained snapshots and absent canonical deployments prevent writes', async (t) => {
    for (const snapshot of [null, { ...active, id: 'wrong' }, { ...active, environment: 'preview' }]) {
        const f = failureFixture(t);
        f.client.pages.projects.deployments.get = async () => snapshot;
        await assert.rejects(cleanupDeployments(f), /Invalid retained deployment snapshot/);
        f.assertNoWrites();
    }
    const f = failureFixture(t);
    f.client.pages.projects.get = async () => ({});
    await assert.rejects(cleanupDeployments(f), /no canonical deployment/);
    f.assertNoWrites();
});

test('malformed vector inventories, repeated IDs and bad lookup records prevent writes', async (t) => {
    for (const page of [{}, { vectors: null, isTruncated: false },
        { vectors: [], isTruncated: 'false' },
        { vectors: [{ id: '' }], isTruncated: false },
        { vectors: [{ id: 1 }], isTruncated: false }]) {
        const f = failureFixture(t);
        f.client.vectorize.indexes.listVectors = async () => page;
        await assert.rejects(cleanupDeployments(f), /Invalid/);
        f.assertNoWrites();
    }
    const repeated = failureFixture(t);
    repeated.client.vectorize.indexes.listVectors = async () => ({
        vectors: [{ id: 'stale' }], isTruncated: true, nextCursor: 'next',
    });
    await assert.rejects(cleanupDeployments(repeated), /Invalid or repeated vector ID/);
    repeated.assertNoWrites();
    for (const records of [null, [{ id: 'wrong' }], [{ id: 'stale' }, { id: 'stale' }]]) {
        const f = failureFixture(t);
        f.client.vectorize.indexes.getByIDs = async () => records;
        await assert.rejects(cleanupDeployments(f), /Incomplete vector records/);
        f.assertNoWrites();
    }
});

test('missing and repeated vector cursors stop pagination before writes', async (t) => {
    for (const cursor of [undefined, 'loop']) {
        const f = failureFixture(t);
        let calls = 0;
        f.client.vectorize.indexes.listVectors = async () => {
            calls++;
            return { vectors: [], isTruncated: true, nextCursor: cursor };
        };
        await assert.rejects(cleanupDeployments(f), /Invalid vector inventory cursor/);
        assert.equal(calls, cursor ? 2 : 1);
        f.assertNoWrites();
    }
});

test('missing retained namespace prevents every destructive operation', async () => {
    const data = fixture();
    data.setDeployments(Array.from({ length: 8 }, (_, index) =>
        deployment(index + 1, index === 7 ? { env_vars: {} } : {})));
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }), /Cannot determine corpus namespace/);
    assert.deepEqual(data.calls, []);
});

test('native cleanup retries are bounded and do not retry invalid requests', async (t) => {
    const timers = retryTimers(t);
    for (const [status, expectedCalls] of [[504, 3], [400, 1]]) {
        let calls = 0;
        const client = createMaintenanceClient('test-token', async () => {
            calls++;
            return Response.json({ success: false, errors: [{ message: 'rejected' }] },
                { status, headers: { 'retry-after': '120' } });
        });
        const pending = assert.rejects(client.pages.projects.get('sg', { account_id: 'account' }),
            error => error instanceof Cloudflare.APIError && error.status === status);
        if (status === 504) {
            for (let retry = 1; retry <= 2; retry++) {
                await timers.waitForRetry(retry);
                timers.resume(retry);
            }
        }
        await pending;
        assert.equal(calls, expectedCalls);
    }
});

test('native cleanup retries honor a 120-second Retry-After header', async (t) => {
    const timers = retryTimers(t);
    let calls = 0;
    const client = createMaintenanceClient('test-token', async () => {
        calls++;
        return calls === 1
            ? new Response(JSON.stringify({ retry_after: 120 }), {
                status: 504, headers: { 'retry-after': '120', 'content-type': 'application/json' },
            })
            : Response.json({ success: true, result: { canonical_deployment: { id: 'active' } } });
    });
    const pending = client.pages.projects.get('sg', { account_id: 'account' });
    await timers.waitForRetry(1);
    assert.equal(calls, 1);
    await setImmediate();
    assert.equal(calls, 1);
    timers.resume(1);
    assert.equal((await pending).canonical_deployment.id, 'active');
    assert.equal(calls, 2);
});

test('preview created during vector deletion makes cleanup fail instead of claiming production-only completion', async () => {
    const data = fixture();
    data.wait = async () => {
        data.setDeployments([...Array.from({ length: 6 }, (_, index) => deployment(index + 3)),
            deployment(99, { environment: 'preview' })]);
    };
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }), /Deployment inventory changed/);
});

test('rejected preview deletion prevents vector pruning', async () => {
    const data = fixture();
    data.setDeployments([...Array.from({ length: 6 }, (_, index) => deployment(index + 3)),
        deployment(99, { environment: 'preview' })]);
    data.client.pages.projects.deployments.delete = async () => { throw new Error('Preview deletion rejected'); };
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }), /Preview deletion rejected/);
    assert.deepEqual(data.calls, []);
});

const failureNamespace = `corpus-${'a'.repeat(56)}`;
const active = {
    id: 'active', created_on: '2026-01-01T00:00:00Z', environment: 'production',
    deployment_trigger: { metadata: { branch: 'develop' } },
    latest_stage: { name: 'deploy', status: 'success' },
    env_vars: { AI_CORPUS_NAMESPACE: { type: 'plain_text', value: failureNamespace } },
};

function failureFixture() {
    const data = fixture();
    data.setDeployments([active]);
    data.setActive(active.id);
    data.client.vectorize.indexes.listVectors = async () => ({ vectors: [{ id: 'stale' }], isTruncated: false });
    data.client.vectorize.indexes.getByIDs = async () => [{ id: 'stale', namespace: namespace(99) }];
    return { ...data, accountId: 'account',
        assertNoWrites() { assert.deepEqual(data.calls, []); } };
}

test('retained namespaces are fetched fresh and a changed snapshot prevents deletion', async () => {
    const data = fixture();
    const get = data.client.pages.projects.deployments.get;
    let reads = 0;
    data.client.pages.projects.deployments.get = async (id, params) => {
        assert.ok(!['d1', 'd2'].includes(id), 'Do not fetch obsolete deployment snapshots');
        const snapshot = await get(id, params);
        reads++;
        return reads > 6 && id === 'd8'
            ? { ...snapshot, env_vars: { AI_CORPUS_NAMESPACE: { type: 'plain_text', value: namespace(99) } } }
            : snapshot;
    };
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }),
        /Deployment inventory changed/);
    assert.deepEqual(data.calls, []);
});

test('retains active deployment plus five successful predecessors, including rollback', () => {
    const deployments = Array.from({ length: 9 }, (_, index) => deployment(index + 1));
    deployments.push(deployment(10, { latest_stage: { name: 'build', status: 'active' } }));
    deployments.push(deployment(11, { latest_stage: { name: 'deploy', status: 'failure' } }));
    deployments.push(deployment(12, { environment: 'preview' }));
    const plan = planRetention(deployments, 'd7', 'develop');
    assert.deepEqual(plan.remove.map(item => item.id), ['d1', 'd8', 'd9', 'd11', 'd12']);
    assert.deepEqual(plan.retain.map(item => item.id), ['d2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd10']);
});

test('retention rejects invalid counts, timestamps and nonproduction active deployments', () => {
    for (const previous of [-1, 1.5, NaN]) {
        assert.throws(() => planRetention([active], 'active', 'develop', previous), /retention count/);
    }
    for (const entry of [{ ...active, created_on: 'invalid' }, { ...active, id: '' }]) {
        assert.throws(() => planRetention([active, entry], 'active', 'develop'), /invalid IDs or timestamps/);
    }
    assert.throws(() => planRetention([{ ...active, environment: 'preview' }], 'active', 'develop'),
        /not production/);
});

test('SDK transport covers Pages deletion, Vectorize batches and mutation readiness', async () => {
    let deployments = [deployment(1), deployment(8), deployment(99, { environment: 'preview' })];
    const removed = [];
    const snapshots = [];
    const vectorRequests = [];
    const stale = Array.from({ length: 110 }, (_, index) => ({ id: `stale-${index}`, namespace: namespace(1) }));
    const vectors = [...stale, { id: 'active', namespace: namespace(8) }];
    const base = '/client/v4/accounts/account/pages/projects/sg';
    const client = createMaintenanceClient('test-token', async (url, init) => {
        const request = new Request(url, init);
        const target = new URL(request.url);
        let result;
        if (target.pathname === base) {
            result = { canonical_deployment: { id: 'd8' } };
        } else if (target.pathname === `${base}/deployments`) {
            const page = Number(target.searchParams.get('page') ?? 1);
            assert.ok(page <= 2, 'SDK pagination must stop after the empty page');
            result = page === 1 ? deployments : [];
        } else if (target.pathname.startsWith(`${base}/deployments/`)) {
            const id = target.pathname.slice(`${base}/deployments/`.length);
            assert.ok(deployments.some(item => item.id === id), `Unexpected deployment ${id}`);
            if (request.method === 'DELETE') {
                removed.push([id, target.searchParams.get('force')]);
                deployments = deployments.filter(item => item.id !== id);
                result = null;
            } else {
                assert.equal(request.method, 'GET');
                snapshots.push(id);
                result = deployments.find(item => item.id === id);
            }
        } else {
            const vectorBase = '/client/v4/accounts/account/vectorize/v2/indexes/portfolio-index';
            const operation = target.pathname.slice(vectorBase.length);
            assert.ok(target.pathname.startsWith(vectorBase));
            if (operation === '/list') {
                assert.equal(request.method, 'GET');
                assert.equal(target.searchParams.get('count'), '1000');
                result = { vectors: vectors.map(({ id }) => ({ id })), isTruncated: false };
            } else if (operation === '/get_by_ids' || operation === '/delete_by_ids') {
                assert.equal(request.method, 'POST');
                assert.equal(request.headers.get('content-type'), 'application/json');
                const { ids } = await request.json();
                assert.ok(ids.length <= (operation === '/get_by_ids' ? 20 : 100));
                vectorRequests.push([operation, ids]);
                result = operation === '/get_by_ids'
                    ? vectors.filter(vector => ids.includes(vector.id))
                    : { mutationId: 'deleted' };
            } else {
                assert.equal(operation, '/info');
                assert.equal(request.method, 'GET');
                vectorRequests.push([operation]);
                result = { dimensions: AI_CONFIG.embedding.dimensions, processedUpToMutation: 'deleted' };
            }
        }
        return Response.json({ success: true, result,
            result_info: { page: 1, per_page: 20, total_pages: 1, count: deployments.length } });
    });
    const result = await cleanupDeployments({ client, accountId: 'account', previous: 0 });
    assert.deepEqual(result.removedDeployments, ['d1', 'd99']);
    assert.deepEqual(removed, [['d1', null], ['d99', 'true']]);
    assert.deepEqual(result.retainedDeployments, ['d8']);
    assert.equal(snapshots.length, 7);
    assert.ok(snapshots.every(id => id === 'd8'));
    assert.equal(result.removedVectors, 110);
    assert.deepEqual(vectorRequests.filter(([operation]) => operation === '/get_by_ids')
        .map(([, ids]) => ids.length), [20, 20, 20, 20, 20, 11]);
    assert.deepEqual(vectorRequests.filter(([operation]) => operation === '/delete_by_ids')
        .map(([, ids]) => ids.length), [100, 10]);
    assert.deepEqual(vectorRequests.filter(([operation]) => operation === '/delete_by_ids')
        .flatMap(([, ids]) => ids), stale.map(({ id }) => id));
    assert.deepEqual(vectorRequests.slice(-4).map(([operation]) => operation),
        ['/delete_by_ids', '/info', '/delete_by_ids', '/info']);
});

test('vector deletion respects the 100-ID limit and waits for each batch', async () => {
    const data = fixture();
    const vectors = Array.from({ length: 110 }, (_, index) => ({
        id: `stale-${index}`, namespace: namespace(99),
    }));
    data.client.vectorize.indexes.listVectors = async () => ({
        vectors: vectors.map(({ id }) => ({ id })), isTruncated: false,
    });
    data.client.vectorize.indexes.getByIDs = async (_, options) => {
        assert.ok(options.ids.length <= 20);
        return vectors.filter(vector => options.ids.includes(vector.id));
    };
    let batchNumber = 0;
    data.client.vectorize.indexes.deleteByIDs = async (_, options) => {
        assert.ok(options.ids.length <= 100);
        const mutationId = `deleted-${++batchNumber}`;
        data.calls.push(['vectors', options.ids]);
        return { mutationId };
    };
    const result = await cleanupDeployments({ ...data, accountId: 'account' });
    assert.equal(result.removedVectors, 110);
    assert.deepEqual(data.calls, [
        ['deployment', 'd1'], ['deployment', 'd2'],
        ['vectors', vectors.slice(0, 100).map(vector => vector.id)], ['ready', 'deleted-1'],
        ['vectors', vectors.slice(100).map(vector => vector.id)], ['ready', 'deleted-2'],
    ]);
});

test('vector deletion without a valid acknowledgement never waits or claims success', async (t) => {
    for (const result of [{}, { mutationId: '' }, { mutationId: ' ' }]) {
        const f = failureFixture(t);
        f.client.vectorize.indexes.deleteByIDs = async () => result;
        await assert.rejects(cleanupDeployments({ ...f,
            wait: async () => assert.fail('Unacknowledged deletion must not wait') }), /mutation ID/);
    }
});

test('vector inventory respects the 20-ID lookup limit across pages and partial batches', async () => {
    const data = fixture();
    const vectors = Array.from({ length: 66 }, (_, index) => ({
        id: `vector-${index}`, namespace: namespace(8),
    }));
    const batches = [];
    data.client.vectorize.indexes.listVectors = async (_, options) => options.cursor
        ? { vectors: vectors.slice(45).map(({ id }) => ({ id })), isTruncated: false }
        : { vectors: vectors.slice(0, 45).map(({ id }) => ({ id })),
            isTruncated: true, nextCursor: 'next' };
    data.client.vectorize.indexes.getByIDs = async (_, options) => {
        assert.ok(options.ids.length <= 20);
        batches.push(options.ids);
        return vectors.filter(vector => options.ids.includes(vector.id));
    };
    const result = await cleanupDeployments({ ...data, accountId: 'account', dryRun: true });
    assert.deepEqual(batches.map(batch => batch.length), [20, 20, 5, 20, 1]);
    assert.deepEqual(batches.flat(), vectors.map(vector => vector.id));
    assert.equal(result.removedVectors, 0);
    assert.deepEqual(data.calls, []);
});
