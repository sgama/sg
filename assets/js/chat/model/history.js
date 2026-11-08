export const STORAGE_KEY = 'ai-chat-history';
export const SESSION_OPEN_KEY = 'ai-chat-open';

/** Saved history is bounded so localStorage cannot grow without limit; the oldest messages are dropped first. */
export const MAX_SAVED_MESSAGES = 50;
export const MAX_API_HISTORY_MESSAGES = 4;
export const MAX_API_HISTORY_MESSAGE_LENGTH = 2000;
export const MAX_API_HISTORY_TOTAL_LENGTH = 4000;

export function apiHistory(messages, welcomeMessage) {
    const selected = [];
    let totalLength = 0;
    for (const message of [...messages].reverse()) {
        if (
            !message ||
            typeof message.text !== 'string' ||
            message.text === welcomeMessage ||
            !['user', 'bot'].includes(message.sender) ||
            !message.text.trim()
        )
            continue;
        const content = message.text.trim();
        if (content.length > MAX_API_HISTORY_MESSAGE_LENGTH || totalLength + content.length > MAX_API_HISTORY_TOTAL_LENGTH) continue;
        selected.push({ role: message.sender === 'bot' ? 'assistant' : 'user', content });
        totalLength += content.length;
        if (selected.length === MAX_API_HISTORY_MESSAGES) break;
    }
    return selected.reverse();
}

export function createStore(getStorage, { json = false } = {}) {
    // Blocked or full storage (private modes, quota) must not break the widget; it simply stops persisting.
    const attempt = (warning, action, fallback) => {
        try {
            return action(getStorage());
        } catch (error) {
            console.warn(warning, error);
            return fallback;
        }
    };
    return {
        get: (key, fallback) =>
            attempt(
                'Chat storage could not be read.',
                (storage) => {
                    const value = storage.getItem(key);
                    return value === null ? fallback : json ? JSON.parse(value) : value;
                },
                fallback,
            ),
        set: (key, value) =>
            attempt('Chat history could not be saved on this device.', (storage) => storage.setItem(key, json ? JSON.stringify(value) : value)),
        remove: (key) => attempt('Chat storage could not be cleared.', (storage) => storage.removeItem(key)),
    };
}

export function readHistory(store, welcome) {
    const value = store.get(STORAGE_KEY, []);
    if (!Array.isArray(value)) {
        console.warn('Ignoring invalid chat history.');
        return [{ sender: 'bot', text: welcome }];
    }
    const history = value.filter(
        (message) => message && typeof message.text === 'string' && message.text.trim() && (message.sender === 'user' || message.sender === 'bot'),
    );
    return history.length ? history : [{ sender: 'bot', text: welcome }];
}
