/**
 * A minimal plugin host for progressive enhancements, shared by every browser script on the site.
 *
 * A feature is `{ name, phase?, init(context) }`. `phase` is 'ready' (default: run as soon as the DOM
 * is ready) or 'idle' (run when the browser is idle, for work that must not delay first paint).
 * Features share nothing but the context `{ document, window, log }`, and one failing feature never
 * stops the others.
 */
const idleScheduler = (window) => (task) =>
    'requestIdleCallback' in window ? window.requestIdleCallback(task, { timeout: 2000 }) : setTimeout(task, 250);

export function createFeatureHost({
    features,
    document = globalThis.document,
    window = globalThis.window,
    schedule = idleScheduler(window),
    log = console,
} = {}) {
    const context = { document, window, log };
    const phaseOf = (feature) => feature.phase ?? 'ready';
    const run = (phase) => {
        for (const feature of features) {
            if (phaseOf(feature) !== phase) continue;
            try {
                feature.init(context);
            } catch (error) {
                log.error(`Feature "${feature.name}" failed.`, error);
            }
        }
    };
    const boot = () => {
        run('ready');
        if (features.some((feature) => phaseOf(feature) === 'idle')) schedule(() => run('idle'));
    };
    return {
        start() {
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
            else boot();
        },
    };
}
