/** One error message for every CLI that needs Cloudflare credentials. */
export function requireCloudflareCredentials(env = process.env) {
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = env;
    if (!accountId || !apiToken) throw new Error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN');
    return { accountId, apiToken };
}
