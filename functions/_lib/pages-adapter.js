/**
 * Adapts a Hono app to a Cloudflare Pages Function. Hono's own `hono/cloudflare-pages` adapter is
 * deprecated (removed in v5), and the app is a plain `fetch` handler, so this is all Pages needs.
 * On Workers with static assets, export `{ fetch: app.fetch }` instead and delete this file.
 */
export const pagesHandler =
    (app) =>
    ({ request, env, waitUntil, passThroughOnException }) =>
        app.fetch(request, env, {
            waitUntil: (promise) => waitUntil(promise),
            passThroughOnException: () => passThroughOnException(),
            props: {},
        });
