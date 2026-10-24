// Pure chat-session helpers shared by the widget. No DOM access, so they are unit-tested directly.

const STAGE_LABELS = {
    rewrite: '🧠 Understanding your follow-up…',
    embedding: '🧩 Preparing source search…',
    search: '🔎 Finding sources…',
    generation: '✍️ Writing answer…',
};

/** Human label for a server progress stage; undefined for unknown stages. */
export function stageLabel(stage) {
    return STAGE_LABELS[stage];
}

/** Explanation shown when a request fails, depending on connectivity. */
export function failureMessage(online) {
    return online ? 'The response could not be completed. Please try again.' : 'You appear to be offline. Check your connection and try again.';
}
