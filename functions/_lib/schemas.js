import { z } from 'zod';
import { CONFIG } from './config.js';

const MessageSchema = z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(CONFIG.HISTORY.MAX_CONTENT_LENGTH),
}).strip();

export const ChatRequestSchema = z.object({
    query: z.string().trim().min(1).max(500),
    history: z.array(MessageSchema).max(CONFIG.HISTORY.MAX_TURNS).default([]),
}).strip().superRefine((val, ctx) => {
    const totalLength = val.history.reduce((sum, m) => sum + m.content.length, 0);
    if (totalLength > CONFIG.HISTORY.MAX_TOTAL_LENGTH) {
        ctx.addIssue({
            code: z.ZodIssueCode.too_big,
            maximum: CONFIG.HISTORY.MAX_TOTAL_LENGTH,
            type: 'string',
            inclusive: true,
            path: ['history'],
            message: `Total history length exceeds ${CONFIG.HISTORY.MAX_TOTAL_LENGTH} characters`,
        });
    }
});
