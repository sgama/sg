import { z } from 'zod';
import { CONFIG } from '../../shared/ai/application.js';
import { SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext } from '../../shared/ai/answer-policy.js';

export { SAFE_NO_CONTEXT_MESSAGE, shouldAbstainForMissingContext };

const MessageSchema = z
    .object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(CONFIG.HISTORY.MAX_CONTENT_LENGTH),
    })
    .strip();

export const ChatRequestSchema = z
    .object({
        query: z.string().trim().min(1).max(CONFIG.QUERY.MAX_LENGTH),
        history: z.array(MessageSchema).max(CONFIG.HISTORY.MAX_TURNS).default([]),
    })
    .strip()
    .superRefine((val, ctx) => {
        const totalLength = val.history.reduce((sum, m) => sum + m.content.length, 0);
        if (totalLength > CONFIG.HISTORY.MAX_TOTAL_LENGTH) {
            ctx.addIssue({
                code: 'too_big',
                maximum: CONFIG.HISTORY.MAX_TOTAL_LENGTH,
                origin: 'string',
                inclusive: true,
                path: ['history'],
                message: `Total history length exceeds ${CONFIG.HISTORY.MAX_TOTAL_LENGTH} characters`,
            });
        }
    });
