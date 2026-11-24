// Offline check that every labeled source in the evaluation fixture exists in the current corpus.
import fs from 'node:fs/promises';
import { runIfMain } from './lib/cli.mjs';
import { buildCorpus } from './lib/corpus.mjs';
import { validateFixture } from './lib/evaluation/fixtures.mjs';

export async function main(fixturePath = 'tests/fixtures/ai-eval.json') {
    const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
    validateFixture(
        fixture,
        (await buildCorpus()).items.map(({ key }) => ({ metadata: { source: key } })),
    );
    console.log(`Evaluation fixture valid: ${fixture.cases.length} cases`);
}

runIfMain(import.meta.url, () => main(process.env.AI_FIXTURE), 'validate_ai_fixture');
