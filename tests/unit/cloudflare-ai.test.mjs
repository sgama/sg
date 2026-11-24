import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireCloudflareCredentials } from '../../scripts/lib/cloudflare-ai.mjs';

test('credentials are required and returned together', () => {
    assert.deepEqual(requireCloudflareCredentials({ CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' }), {
        accountId: 'account',
        apiToken: 'token',
    });
    for (const env of [
        {},
        { CLOUDFLARE_ACCOUNT_ID: 'account' },
        { CLOUDFLARE_API_TOKEN: 'token' },
        { CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: 'token' },
    ]) {
        assert.throws(() => requireCloudflareCredentials(env), /Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN/);
    }
});
