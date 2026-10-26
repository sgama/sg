import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupVectors, main } from '../../scripts/cleanup_vectors.mjs';
import { createMaintenanceClient } from '../../scripts/lib/corpus-deployment.mjs';
import { activeWorker } from '../../scripts/lib/worker-deployment.mjs';

const ns = (letter) => `corpus-${letter.repeat(56)}`;
const [LIVE, OLD, OLDER, PREVIOUS] = [ns('a'), ns('b'), ns('c'), ns('d')];
const settings = (namespace, previousNamespace) => ({
    bindings: [
        { type: 'kv_namespace', name: 'CHAT_LOGS' },
        ...(namespace ? [{ type: 'plain_text', name: 'AI_CORPUS_NAMESPACE', text: namespace }] : []),
        ...(previousNamespace ? [{ type: 'plain_text', name: 'AI_PREVIOUS_CORPUS_NAMESPACE', text: previousNamespace }] : []),
    ],
});

/** A client with 230 vectors in an old corpus, one in an older one, the live corpus, and two unversioned namespaces. */
function fixture({ liveNow = LIVE, liveLater = liveNow, previousNow = PREVIOUS, previousLater = previousNow } = {}) {
    const vectors = [
        ...Array.from({ length: 230 }, (_, index) => ({ id: `old-${index}`, namespace: OLD })),
        { id: 'older', namespace: OLDER },
        { id: 'previous', namespace: PREVIOUS },
        { id: 'live', namespace: LIVE },
        { id: 'legacy', namespace: '' },
        { id: 'foreign', namespace: 'custom' },
    ];
    const calls = [];
    const deleted = [];
    let reads = 0;
    const client = {
        workers: {
            scripts: {
                scriptAndVersionSettings: {
                    get: async () => {
                        reads += 1;
                        const live = reads === 1 ? liveNow : liveLater;
                        const previous = reads === 1 ? previousNow : previousLater;
                        return settings(live, previous);
                    },
                },
            },
        },
        vectorize: {
            indexes: {
                listVectors: async (_, options) =>
                    options.cursor
                        ? { vectors: vectors.slice(120).map(({ id }) => ({ id })), isTruncated: false }
                        : { vectors: vectors.slice(0, 120).map(({ id }) => ({ id })), isTruncated: true, nextCursor: 'next' },
                getByIDs: async (_, options) => {
                    assert.ok(options.ids.length > 0 && options.ids.length <= 20, 'Vectorize rejects more than 20 IDs per lookup');
                    return vectors.filter((vector) => options.ids.includes(vector.id));
                },
                deleteByIDs: async (_, options) => {
                    assert.ok(options.ids.length > 0 && options.ids.length <= 20, 'Vectorize rejects more than 20 IDs per delete');
                    deleted.push(...options.ids);
                    calls.push(['delete', options.ids.length]);
                    return { mutationId: `m${calls.length}` };
                },
            },
        },
    };
    return { client, calls, deleted, accountId: 'account' };
}

test('prunes every versioned corpus except live and previous, in delete batches of 20, without awaiting Vectorize', async () => {
    const f = fixture();
    const logs = [];
    const result = await cleanupVectors({ ...f, progress: (line) => logs.push(line) });
    assert.deepEqual(result, { dryRun: false, liveNamespace: LIVE, removedVectors: 231 });
    assert.deepEqual(
        f.calls,
        Array.from({ length: 12 }, (_, index) => ['delete', index < 11 ? 20 : 11]),
    );
    assert.ok(
        !f.deleted.some((id) => ['live', 'previous', 'legacy', 'foreign'].includes(id)),
        'live, previous, unversioned and foreign vectors are never touched',
    );
    assert.ok(f.deleted.includes('older'));
    assert.ok(
        logs.some((line) => /page 1: 120 vectors/.test(line)),
        'the scan reports each page so progress is visible',
    );
    assert.ok(logs.some((line) => /delete 231\/231/.test(line)));
    assert.ok(logs.some((line) => /last mutation m12 not awaited/.test(line)));
});

test('a dry run reports the plan without any write', async () => {
    const f = fixture();
    assert.equal((await cleanupVectors({ ...f, dryRun: true })).removedVectors, 231);
    assert.deepEqual(f.calls, []);
});

test('cleanup refuses without a live namespace and stops if a deploy changes it mid-run', async () => {
    for (const [options, message] of [
        [{ liveNow: '' }, /live corpus namespace/],
        [{ liveLater: OLDER }, /changed during cleanup/],
    ]) {
        const f = fixture(options);
        await assert.rejects(cleanupVectors(f), message);
        assert.deepEqual(f.calls, [], 'nothing is deleted');
    }
});

test('malformed inventories, bad cursors, incomplete records and unacknowledged deletions never delete or claim success', async () => {
    const breakIt = [
        [(c) => (c.vectorize.indexes.listVectors = async () => ({})), /Invalid vector inventory/],
        [(c) => (c.vectorize.indexes.listVectors = async () => ({ vectors: [{ id: 'x' }], isTruncated: 'no' })), /Invalid vector inventory/],
        [(c) => (c.vectorize.indexes.listVectors = async () => ({ vectors: [], isTruncated: true })), /Invalid vector inventory cursor/],
        [(c) => (c.vectorize.indexes.getByIDs = async () => []), /Incomplete vector records/],
        [(c) => (c.vectorize.indexes.deleteByIDs = async () => ({ mutationId: ' ' })), /mutation ID/],
    ];
    for (const [change, message] of breakIt) {
        const f = fixture();
        change(f.client);
        await assert.rejects(cleanupVectors(f), message);
    }
});

test('the live Worker lookup reads plain-text variables, treats a missing Worker as not deployed, and rejects a bad namespace', async () => {
    const get = (impl) => ({ workers: { scripts: { scriptAndVersionSettings: { get: impl } } } });
    const bindings = [
        { type: 'plain_text', name: 'AI_CORPUS_NAMESPACE', text: LIVE },
        { type: 'plain_text', name: 'DEPLOY_COMMIT', text: 'f'.repeat(40) },
        { type: 'secret_text', name: 'AI_CORPUS_NAMESPACE', text: 'ignored' },
    ];
    assert.deepEqual(
        await activeWorker(
            get(async () => ({ bindings })),
            'account',
        ),
        { namespace: LIVE, commit: 'f'.repeat(40) },
    );
    assert.deepEqual(
        await activeWorker(
            get(async () => ({ bindings: [...bindings, { type: 'plain_text', name: 'AI_PREVIOUS_CORPUS_NAMESPACE', text: PREVIOUS }] })),
            'account',
        ),
        { namespace: LIVE, previousNamespace: PREVIOUS, commit: 'f'.repeat(40) },
    );
    assert.equal(
        await activeWorker(
            get(async () => Promise.reject(Object.assign(new Error('missing'), { status: 404 }))),
            'account',
        ),
        null,
    );
    await assert.rejects(
        activeWorker(
            get(async () => ({ bindings: [{ type: 'plain_text', name: 'AI_CORPUS_NAMESPACE', text: 'bad' }] })),
            'account',
        ),
        /Invalid active corpus/,
    );
});

test('the real SDK reads Worker settings and deletes vectors with the documented requests', async () => {
    const requests = [];
    const vectors = Array.from({ length: 3 }, (_, index) => ({ id: `old-${index}`, namespace: OLD }));
    const client = createMaintenanceClient('test-token', async (url, init) => {
        const request = new Request(url, init);
        const { pathname, searchParams } = new URL(request.url);
        requests.push(`${request.method} ${pathname.replace('/client/v4/accounts/account', '')}`);
        const index = '/vectorize/v2/indexes/portfolio-index';
        let result;
        if (pathname.endsWith('/workers/scripts/sg/settings')) result = settings(LIVE);
        else if (pathname.endsWith(`${index}/list`))
            result = { vectors: vectors.map(({ id }) => ({ id })), isTruncated: false, count: searchParams.get('count') };
        else if (pathname.endsWith(`${index}/get_by_ids`)) result = vectors;
        else if (pathname.endsWith(`${index}/delete_by_ids`)) result = { mutationId: 'deleted' };
        else assert.fail(`Unexpected request ${pathname}`);
        return Response.json({ success: true, result });
    });
    const result = await cleanupVectors({ client, accountId: 'account' });
    assert.equal(result.removedVectors, 3);
    assert.deepEqual(
        requests.map((line) => line.replace(/\/portfolio-index/, '')),
        [
            'GET /workers/scripts/sg/settings',
            'GET /vectorize/v2/indexes/list',
            'POST /vectorize/v2/indexes/get_by_ids',
            'GET /workers/scripts/sg/settings',
            'POST /vectorize/v2/indexes/delete_by_ids',
        ],
    );
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
