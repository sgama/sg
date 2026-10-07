import { z } from 'zod';
import { CONFIG } from './config.js';

const PROMPT_INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
    /disregard\s+(all\s+)?(system|developer|safety)\s+instructions?/i,
    /reveal\s+(the\s+)?(system|hidden|developer)\s+prompt/i,
    /print\s+(the\s+)?(system|hidden|developer)\s+prompt/i,
    /you\s+are\s+now\s+(an|a)\s+/i,
    /act\s+as\s+(an|a)\s+/i,
];

export const SAFE_NO_CONTEXT_MESSAGE = "I don't have enough reliable context to answer that yet. Please ask about Samson's portfolio, projects, skills, or experience.";

export function isPromptInjectionAttempt(query) {
    if (!query || typeof query !== 'string') return false;
    return PROMPT_INJECTION_PATTERNS.some(pattern => pattern.test(query));
}

export function shouldAbstainForMissingContext(contextText, minimumChars = 20) {
    if (typeof contextText !== 'string') return true;
    return contextText.trim().length < minimumChars;
}

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
