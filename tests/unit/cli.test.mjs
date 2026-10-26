import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runIfMain } from '../../scripts/lib/cli.mjs';

test('runIfMain keeps the failing exit code and prints the original stack', async () => {
    const previousArgv = process.argv[1];
    const previousConsoleError = console.error;
    const previousExitCode = process.exitCode;
    const lines = [];

    process.argv[1] = fileURLToPath(import.meta.url);
    console.error = (...args) => {
        lines.push(args.join(' '));
    };

    try {
        runIfMain(
            import.meta.url,
            async () => {
                throw new Error('boom');
            },
            'demo command',
        );
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(process.exitCode, 1);
        assert.match(lines.join('\n'), /demo command: Error: boom/);
        assert.match(lines.join('\n'), /at .*cli\.test/);
    } finally {
        console.error = previousConsoleError;
        process.argv[1] = previousArgv;
        process.exitCode = previousExitCode;
    }
});
