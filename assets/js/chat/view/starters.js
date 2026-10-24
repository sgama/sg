/** Shortcut buttons for an empty conversation. `onPick(query)` receives the canned question. */
export function createStarters(items, onPick) {
    const starters = document.createElement('div');
    starters.classList.add('chat-starters');
    for (const [label, query] of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => onPick(query));
        starters.append(button);
    }
    return starters;
}
