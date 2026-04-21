/**
 * Pure chat-history sanitizer. Keeps only well-formed user/assistant turns
 * within length limits and truncates to the N most recent.
 */

const VALID_ROLES = new Set(["user", "assistant"]);

export function sanitizeHistory(raw, { maxTurns, maxContentLength }) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(m =>
            m && typeof m === "object"
            && VALID_ROLES.has(m.role)
            && typeof m.content === "string"
            && m.content.length > 0
            && m.content.length <= maxContentLength
        )
        .map(m => ({ role: m.role, content: m.content }))
        .slice(-maxTurns);
}
