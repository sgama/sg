import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-local-lifecycle-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const log = path.join(dir, 'calls.jsonl');
    const mock = `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'volume' && args[1] === 'inspect') console.log(process.env.OWNER || 'true');
if (args.includes('port')) console.log('127.0.0.1:12345');
if (args.includes('ps')) console.log('container-id');
if (args[0] === 'inspect') console.log('sha256:image');
if (args.includes('pull') && process.env.PULL_FAIL) process.exit(1);
if (args[0] === 'scripts/ai-local-eval.mjs') process.exit(Number(process.env.EVAL_EXIT || 0));
`;
    for (const name of ['docker', 'node', 'curl']) {
        await fs.writeFile(path.join(dir, name), mock, { mode: 0o700 });
    }
    return {
        async run(args = [], overrides = {}) {
            await fs.writeFile(log, '');
            const result = spawnSync('bash', ['scripts/run_local_ai.sh', ...args], {
                cwd: root, encoding: 'utf8', timeout: 10000,
                env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log,
                    DOCKER: path.join(dir, 'docker'), NODE: path.join(dir, 'node'),
                    AI_LOCAL_VOLUME: 'sg-test-cache', AI_LOCAL_IMAGE: 'ollama:test',
                    AI_LOCAL_MODEL: 'local', AI_LOCAL_EMBED_MODEL: 'embed', AI_LOCAL_DIMENSIONS: '2',
                    AI_FIXTURE: 'fixture.json', AI_REPEATS: '1', AI_LOCAL_TIMEOUT_MS: '1000',
                    AI_MIN_HIT_RATE: '0.9', AI_MIN_ANSWER_RATE: '0.8', AI_LOCAL_REPORT: 'report.json',
                    ...overrides },
            });
            assert.ifError(result.error);
            const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
            return { ...result, calls };
        },
    };
}

test('cache cleanup requires ownership and never force-deletes volumes', async t => {
    const mock = await fixture(t);
    const unowned = await mock.run(['clean'], { OWNER: 'false' });
    assert.notEqual(unowned.status, 0);
    assert.match(unowned.stderr, /unowned volume/);
    assert.ok(!unowned.calls.some(args => args.includes('rm')));
    const owned = await mock.run(['clean']);
    assert.equal(owned.status, 0, owned.stderr);
    assert.deepEqual(owned.calls.at(-1), ['volume', 'rm', 'sg-test-cache']);
});

test('hybrid lifecycle stops embeddings and never starts or pulls local generation', async t => {
    const mock = await fixture(t);
    const result = await mock.run([], { AI_LOCAL_GENERATION: 'cloudflare',
        CLOUDFLARE_ACCOUNT_ID: 'offline', CLOUDFLARE_API_TOKEN: 'offline' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.calls.some(args => args.includes('stop') && args.includes('embeddings')));
    assert.ok(!result.calls.some(args => args.includes('ollama')));
    assert.ok(result.calls.at(-1).includes('down'));
});

test('one-shot lifecycle keeps model cache and cleans only its Compose project on success or failure', async t => {
    const mock = await fixture(t);
    for (const overrides of [{}, { EVAL_EXIT: '1' }, { PULL_FAIL: 'true' }]) {
        const result = await mock.run([], overrides);
        assert.equal(result.status, Object.keys(overrides).length ? 1 : 0, result.stderr);
        const commands = result.calls.filter(args => args[0] === 'compose');
        assert.ok(commands.some(args => args.includes('up')));
        const stop = commands.findIndex(args => args.includes('stop') && args.includes('embeddings'));
        const generation = commands.findIndex(args => args.includes('up') && args.includes('ollama'));
        if (!overrides.EVAL_EXIT) assert.ok(stop >= 0 && generation > stop);
        assert.ok(commands.at(-1).includes('down'));
        assert.ok(commands.every(args => args[4] === commands[0][4]));
        assert.ok(commands[0][4].startsWith('sg-ai-local-'));
        assert.ok(!commands.some(args => args.includes('--volumes')));
        assert.ok(!result.calls.some(args => args[0] === 'volume' && args[1] === 'rm'));
    }
});
