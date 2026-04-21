const encoder = new TextEncoder();

export function createSseMessageStream(message) {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: message })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        }
    });
}

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
