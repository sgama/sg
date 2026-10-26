import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildMessages } from '../../../functions/_lib/prompts.js';

export function fixtureHash(fixture) {
    return createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
}

export const promptHash = () => fixtureHash(buildMessages('__query__', '__context__'));

const ID_ERROR = 'Evaluation cases need unique IDs and nonempty queries';
const present = (value) => value.trim().length > 0;
const label = z.string().refine(present); // a term that is not blank
const exact = z.string().min(1); // an answer or forbidden term, kept as written
const groupsOf = (term) => z.array(z.array(term).min(1)).min(1);
const turn = z.object({ role: z.enum(['user', 'assistant']), content: z.string().refine(present).max(2000) });
const FixtureCase = z
    .object({
        id: z.string().min(1),
        query: z.string().refine(present),
        evidenceTerms: groupsOf(label).optional(),
        required: z.boolean().optional(),
        history: z.array(turn).max(4).optional(),
        retrievalTerms: groupsOf(label).optional(),
        expectedSources: z.array(z.string()),
        answerTerms: groupsOf(exact),
        forbiddenTerms: z.array(exact),
    })
    .superRefine((item, ctx) => {
        const fail = (path) => ctx.addIssue({ code: 'custom', path: [path], message: path });
        if (item.evidenceTerms && !item.expectedSources.length) fail('evidenceTerms');
        if (item.history && item.history.reduce((sum, message) => sum + message.content.length, 0) > 4000) fail('history');
        if (item.retrievalTerms && !item.history?.length) fail('retrievalTerms');
    });
// Which label problem each field reports; id and query problems share one message.
const CASE_PROBLEMS = {
    evidenceTerms: 'evidence labels',
    required: 'required flag',
    history: 'conversation history',
    retrievalTerms: 'retrieval query labels',
    expectedSources: 'labels',
    answerTerms: 'labels',
    forbiddenTerms: 'forbidden terms',
};

export function validateFixture(fixture, chunks) {
    if (!fixture || fixture.version !== 1 || !Array.isArray(fixture.cases) || !fixture.cases.length) {
        throw new Error('Evaluation fixture must have version 1 and nonempty cases');
    }
    const sources = new Set(chunks.map((chunk) => chunk.metadata.source));
    const ids = new Set();
    for (const item of fixture.cases) {
        const parsed = FixtureCase.safeParse(item);
        if (!parsed.success) {
            const problem = CASE_PROBLEMS[parsed.error.issues[0].path[0]];
            throw new Error(problem ? `Invalid ${problem} for ${item.id}` : ID_ERROR);
        }
        if (ids.has(item.id)) throw new Error(ID_ERROR);
        ids.add(item.id);
        for (const source of item.expectedSources) {
            if (!sources.has(source)) throw new Error(`Missing labeled source ${source}`);
        }
    }
}
