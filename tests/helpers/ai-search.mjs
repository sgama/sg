/**
 * Stateful mock of the Cloudflare REST endpoints the index pipeline uses (Workers settings and AI Search instances/items).
 * Pass `fetchImpl` to the real `cloudflare` SDK so the tests exercise its actual request shapes.
 * @param {{ vars?: Record<string, string> | null, instances?: Record<string, string[]>, itemStatus?: string, failUploadKey?: string }} [options]
 */
export function aiSearchMock({ vars = null, instances = {}, itemStatus = 'completed', failUploadKey } = {}) {
    const base = '/client/v4/accounts/account';
    const namespace = `${base}/ai-search/namespaces/default/instances`;
    /** @type {Map<string, { config?: any, items: Map<string, { status: string, metadata: any, text: string, error?: string }> }>} */
    const store = new Map(
        Object.entries(instances).map(([id, keys]) => [
            id,
            { items: new Map(keys.map((key) => [key, { status: 'completed', metadata: {}, text: '' }])) },
        ]),
    );
    /** @type {{ method: string, pathname: string }[]} */
    const requests = [];
    const state = { vars, store, requests, uploads: /** @type {{ key: string, metadata: any, text: string }[]} */ ([]), pollsUntilDone: 0 };
    const ok = (/** @type {unknown} */ result, /** @type {object} */ extra = {}) => Response.json({ success: true, result, ...extra });
    const missing = () => Response.json({ success: false, errors: [{ code: 7003, message: 'Not found' }] }, { status: 404 });

    /** @param {string | URL | Request} url @param {RequestInit} [init] */
    const fetchImpl = async (url, init) => {
        const request = new Request(url, init);
        const { pathname: raw, searchParams } = new URL(request.url);
        const pathname = decodeURIComponent(raw);
        const method = request.method;
        requests.push({ method, pathname });
        if (pathname === `${base}/workers/scripts/sg/settings`) {
            if (!state.vars) return missing();
            return ok({ bindings: Object.entries(state.vars).map(([name, text]) => ({ type: 'plain_text', name, text })) });
        }
        const page = (/** @type {unknown[]} */ all) => {
            const size = Number(searchParams.get('per_page') ?? 20);
            const number = Number(searchParams.get('page') ?? 1);
            return ok(all.slice((number - 1) * size, number * size), { result_info: { page: number, per_page: size, total_count: all.length } });
        };
        if (pathname === namespace) {
            if (method === 'POST') {
                const config = await request.json();
                if (store.has(config.id)) return Response.json({ success: false, errors: [{ code: 7002, message: 'exists' }] }, { status: 409 });
                store.set(config.id, { config, items: new Map() });
                return ok({ id: config.id });
            }
            const search = searchParams.get('search') ?? '';
            return page([...store.keys()].filter((id) => id.includes(search)).map((id) => ({ id })));
        }
        const match = pathname.startsWith(`${namespace}/`) && pathname.slice(namespace.length + 1).match(/^([^/]+)(\/items)?$/);
        if (!match) throw new Error(`Unexpected request: ${method} ${pathname}`);
        const instance = store.get(match[1]);
        if (!instance) return missing();
        if (!match[2]) {
            if (method === 'DELETE') {
                store.delete(match[1]);
                return ok({ id: match[1] });
            }
            return ok({ id: match[1] });
        }
        if (method === 'POST') {
            const form = await request.formData();
            const file = /** @type {File} */ (form.get('file'));
            const key = file.name;
            const record = { key, metadata: JSON.parse(String(form.get('metadata') ?? '{}')), text: await file.text() };
            if (key === failUploadKey) return Response.json({ success: false, errors: [{ code: 1, message: 'boom' }] }, { status: 400 });
            state.uploads.push(record);
            instance.items.set(key, { status: 'queued', metadata: record.metadata, text: record.text });
            return ok({ id: key, key, status: 'queued' });
        }
        // Each listing advances queued items toward the final status, like successive polls of a real instance.
        const items = [...instance.items].map(([key, item]) => {
            if (item.status === 'queued' && state.pollsUntilDone-- <= 0) item.status = itemStatus;
            return { id: key, key, status: item.status, error: item.error };
        });
        return page(items);
    };
    return Object.assign(state, { fetchImpl });
}
