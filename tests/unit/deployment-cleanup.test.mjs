import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupDeployments, planRetention, referencedNamespaces } from '../../scripts/cleanup_deployments.mjs';

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
                get: async (_, id) => deployments.find(item => item.id === id),
                delete: async (_, id) => {
                    calls.push(['deployment', id]);
                    deployments = deployments.filter(item => item.id !== id);
                },
            },
        } },
        vectorize: { indexes: {
            listVectors: async (_, options) => options.cursor
                ? { vectors: vectors.slice(2).map(({ id }) => ({ id })), isTruncated: false }
                : { vectors: vectors.slice(0, 2).map(({ id }) => ({ id })), isTruncated: true, nextCursor: 'next' },
            getByIds: async (_, options) => vectors.filter(vector => options.ids.includes(vector.id)),
            deleteByIds: async (_, options) => { calls.push(['vectors', options.ids]); return { mutationId: 'deleted' }; },
        } },
    };
    return { client, calls, wait: async (_, __, id) => calls.push(['ready', id]),
        setDeployments: value => { deployments = value; }, setActive: value => { active = value; } };
}

test('retains active deployment plus five successful predecessors, including rollback', () => {
    const deployments = Array.from({ length: 9 }, (_, index) => deployment(index + 1));
    deployments.push(deployment(10, { latest_stage: { name: 'build', status: 'active' } }));
    deployments.push(deployment(11, { latest_stage: { name: 'deploy', status: 'failure' } }));
    deployments.push(deployment(12, { environment: 'preview' }));
    const plan = planRetention(deployments, 'd7', 'develop');
    assert.deepEqual(plan.remove.map(item => item.id), ['d1', 'd8', 'd9', 'd11', 'd12']);
    assert.deepEqual(plan.retain.map(item => item.id), ['d2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd10']);
});

test('incomplete deployment metadata blocks destructive cleanup', () => {
    assert.throws(() => planRetention([], 'missing', 'develop'), /Active deployment/);
    assert.throws(() => referencedNamespaces([deployment(1, { env_vars: {} })]), /refusing vector cleanup/);
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

test('rejected preview deletion prevents vector pruning', async () => {
    const data = fixture();
    data.setDeployments([...Array.from({ length: 6 }, (_, index) => deployment(index + 3)),
        deployment(99, { environment: 'preview' })]);
    data.client.pages.projects.deployments.delete = async () => { throw new Error('Preview deletion rejected'); };
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }), /Preview deletion rejected/);
    assert.deepEqual(data.calls, []);
});

test('preview created during vector deletion makes cleanup fail instead of claiming production-only completion', async () => {
    const data = fixture();
    data.wait = async () => {
        data.setDeployments([...Array.from({ length: 6 }, (_, index) => deployment(index + 3)),
            deployment(99, { environment: 'preview' })]);
    };
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }), /Deployment inventory changed/);
});

test('failed deployment deletion prevents all vector deletion', async () => {
    const data = fixture();
    data.client.pages.projects.deployments.delete = async () => { throw new Error('Delete failed'); };
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }), /Delete failed/);
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

test('incomplete vector fetch prevents deployment deletion', async () => {
    const data = fixture();
    data.client.vectorize.indexes.getByIds = async () => [];
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }), /Incomplete vector records/);
    assert.deepEqual(data.calls, []);
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
    data.client.vectorize.indexes.getByIds = async (_, options) => {
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

test('missing retained namespace prevents every destructive operation', async () => {
    const data = fixture();
    data.setDeployments(Array.from({ length: 8 }, (_, index) =>
        deployment(index + 1, index === 7 ? { env_vars: {} } : {})));
    await assert.rejects(cleanupDeployments({ ...data, accountId: 'account' }), /Cannot determine corpus namespace/);
    assert.deepEqual(data.calls, []);
});

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
