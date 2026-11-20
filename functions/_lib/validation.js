import { z } from 'zod';
import { CONFIG } from './application.js';

export const SAFE_NO_CONTEXT_MESSAGE =
    "I don't have enough reliable context to answer that yet. Please ask about Samson's portfolio, projects, skills, or experience.";

export function shouldAbstainForMissingContext(contextText, minimumChars = CONFIG.ABSTAIN.MIN_CONTEXT_CHARS) {
    if (typeof contextText !== 'string') return true;
    return contextText.trim().length < minimumChars;
}

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
