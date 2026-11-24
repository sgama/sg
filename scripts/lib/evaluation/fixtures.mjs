import { z } from 'zod';

const ID_ERROR = 'Evaluation cases need unique IDs and nonempty queries';
/** @param {string} value */
const present = (value) => value.trim().length > 0;
const label = z.string().refine(present); // a term that is not blank
const exact = z.string().min(1); // an answer or forbidden term, kept as written
/** @param {z.ZodType<string>} term */
const groupsOf = (term) => z.array(z.array(term).min(1)).min(1);
const turn = z.object({ role: z.enum(['user', 'assistant']), content: z.string().refine(present).max(2000) });
const FixtureCase = z
    .object({
        id: z.string().min(1),
        query: z.string().refine(present),
        evidenceTerms: groupsOf(label).optional(),
        history: z.array(turn).max(4).optional(),
        retrievalTerms: groupsOf(label).optional(),
        expectedSources: z.array(z.string()),
        answerTerms: groupsOf(exact),
        forbiddenTerms: z.array(exact),
    })
    .superRefine((item, ctx) => {
        const fail = (/** @type {string} */ path) => ctx.addIssue({ code: 'custom', path: [path], message: path });
        if (item.evidenceTerms && !item.expectedSources.length) fail('evidenceTerms');
        if (item.history && item.history.reduce((sum, message) => sum + message.content.length, 0) > 4000) fail('history');
        if (item.retrievalTerms && !item.history?.length) fail('retrievalTerms');
    });
/** @typedef {z.infer<typeof FixtureCase>} FixtureCase */
// Which label problem each field reports; id and query problems share one message.
/** @type {Record<string, string>} */
const CASE_PROBLEMS = {
    evidenceTerms: 'evidence labels',
    history: 'conversation history',
    retrievalTerms: 'retrieval query labels',
    expectedSources: 'labels',
    answerTerms: 'labels',
    forbiddenTerms: 'forbidden terms',
};

/**
 * @param {any} fixture parsed JSON, validated here
 * @param {{ metadata: { source: string } }[]} chunks
 */
export function validateFixture(fixture, chunks) {
    if (!fixture || fixture.version !== 1 || !Array.isArray(fixture.cases) || !fixture.cases.length) {
        throw new Error('Evaluation fixture must have version 1 and nonempty cases');
    }
    const sources = new Set(chunks.map((chunk) => chunk.metadata.source));
    const ids = new Set();
    for (const item of fixture.cases) {
        const parsed = FixtureCase.safeParse(item);
        if (!parsed.success) {
            const field = parsed.error.issues[0].path[0];
            const problem = typeof field === 'string' ? CASE_PROBLEMS[field] : undefined;
            throw new Error(problem ? `Invalid ${problem} for ${item.id}` : ID_ERROR);
        }
        if (ids.has(item.id)) throw new Error(ID_ERROR);
        ids.add(item.id);
        for (const source of item.expectedSources) {
            if (!sources.has(source)) throw new Error(`Missing labeled source ${source}`);
        }
    }
}
