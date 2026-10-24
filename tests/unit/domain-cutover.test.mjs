import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutoverDomains } from '../../scripts/cutover_domains.mjs';

function fixture({ failAttach = false } = {}) {
    const calls = [];
    const client = {
        pages: {
            projects: {
                domains: {
                    list: async function* () {
                        yield* [{ name: 'sg.pages.dev' }, { name: 'example.com' }, { name: 'www.example.com' }];
                    },
                    delete: async (name) => calls.push(`detach ${name}`),
                    create: async (_project, { name }) => calls.push(`restore ${name}`),
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
    await assert.rejects(cutoverDomains(failing), /restored it on Pages: zone not found/);
    assert.deepEqual(failing.calls, ['detach example.com', 'restore example.com']);
});
