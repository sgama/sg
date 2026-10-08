export const STORAGE_KEY = 'ai-chat-history';
export const SESSION_OPEN_KEY = 'ai-chat-open';

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
