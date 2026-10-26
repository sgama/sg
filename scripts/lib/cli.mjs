import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Runs `main` only when the module is the process entry point, reporting a failure with `label` and a non-zero exit code. */
export function runIfMain(moduleUrl, main, label) {
    if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(moduleUrl)) return;
    main().catch((error) => {
        const cause = error instanceof Error ? error : new Error(String(error));
        console.error(`${label}: ${cause.stack || cause.toString()}`);
        process.exitCode = 1;
    });
}
