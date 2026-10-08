export const STORAGE_KEY = 'ai-chat-history';
export const SESSION_OPEN_KEY = 'ai-chat-open';

const MAX_API_HISTORY_MESSAGES = 4;
const MAX_API_HISTORY_MESSAGE_LENGTH = 2000;
const MAX_API_HISTORY_TOTAL_LENGTH = 4000;

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
    return {
        get(key, fallback) {
            try {
                const value = getStorage().getItem(key);
                return value === null ? fallback : json ? JSON.parse(value) : value;
            } catch (error) {
                console.warn('Chat storage could not be read.', error);
                return fallback;
            }
        },
        set(key, value) {
            try {
                getStorage().setItem(key, json ? JSON.stringify(value) : value);
            } catch (error) {
                console.warn('Chat history could not be saved on this device.', error);
            }
        },
        remove(key) {
            try {
                getStorage().removeItem(key);
            } catch (error) {
                console.warn('Chat storage could not be cleared.', error);
            }
        },
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
