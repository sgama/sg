import { CONFIG } from './application.js';

export const SAFE_NO_CONTEXT_MESSAGE =
    "I don't have enough reliable context to answer that yet. Please ask about Samson's portfolio, projects, skills, or experience.";

export function shouldAbstainForMissingContext(contextText, minimumChars = CONFIG.ABSTAIN.MIN_CONTEXT_CHARS) {
    if (typeof contextText !== 'string') return true;
    return contextText.trim().length < minimumChars;
}
