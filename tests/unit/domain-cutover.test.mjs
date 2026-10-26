import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutoverDomains } from '../../scripts/cutover_domains.mjs';

function fixture({ failAttach = false, failRestore = false } = {}) {
    const calls = [];
    const client = {
        pages: {
            projects: {
                domains: {
                    list: async function* () {
                        yield* [{ name: 'sg.pages.dev' }, { name: 'example.com' }, { name: 'www.example.com' }];
                    },
                    delete: async (name) => calls.push(`detach ${name}`),
                    create: async (_project, { name }) => {
                        calls.push(`restore ${name}`);
                        if (failRestore) throw new Error('Pages restore failed');
                    },
                },
            },
        },
        workers: {
            domains: {
                update: async ({ hostname, service, zone_name }) => {
                    if (failAttach) throw new Error('zone not found');
                    calls.push(`attach ${hostname} ${service} ${zone_name}`);
                },
            },
        },
    };
    return { client, calls, accountId: 'account', zone: 'example.com', log: () => {} };
}

test('moves each custom domain from Pages to the Worker and skips pages.dev', async () => {
    const f = fixture();
    const result = await cutoverDomains(f);
    assert.deepEqual(result.moved, ['example.com', 'www.example.com']);
    assert.deepEqual(f.calls, [
        'detach example.com',
        'attach example.com sg example.com',
        'detach www.example.com',
        'attach www.example.com sg example.com',
    ]);
});

test('a dry run changes nothing, and a failed attachment restores the hostname on Pages', async () => {
    const dry = fixture();
    assert.deepEqual((await cutoverDomains({ ...dry, dryRun: true })).moved, []);
    assert.deepEqual(dry.calls, []);
    const failing = fixture({ failAttach: true });
    await assert.rejects(cutoverDomains(failing), /Could not attach example.com to Worker sg; restored it on Pages/);
    assert.deepEqual(failing.calls, ['detach example.com', 'restore example.com']);
});

test('a failed restoration keeps both attach and restore failures and their causes', async () => {
    const failing = fixture({ failAttach: true, failRestore: true });
    await assert.rejects(cutoverDomains(failing), (error) => {
        assert.equal(error.name, 'AggregateError');
        assert.match(error.message, /Could not attach example.com to Worker sg/);
        assert.match(error.message, /restore on Pages failed too/);
        assert.match(error.message, /reattach example.com on Pages/);
        assert.equal(error.cause.message, 'Could not attach example.com to Worker sg after detaching it from Pages.');
        assert.equal(error.cause.cause.message, 'zone not found');
        assert.equal(error.errors[1].cause.message, 'Pages restore failed');
        assert.equal(error.errors[0].cause.message, 'zone not found');
        return true;
    });
    assert.deepEqual(failing.calls, ['detach example.com', 'restore example.com']);
});
