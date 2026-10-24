const ROLES = ['toggle', 'window', 'close', 'clear', 'form', 'input', 'send', 'stop', 'messages', 'transcript', 'latest', 'status'];

/**
 * Finds the widget's DOM by `data-role`, cloning the page template first when the host is empty.
 * Returns null after logging the reason, which leaves the widget inert instead of half-working.
 */
export function hydrate(host, { document = globalThis.document, log = console } = {}) {
    if (!host.querySelector('[data-role="window"]')) {
        const template = document.getElementById('ai-chat-template');
        if (!template) {
            log.error('Chat widget template is missing.');
            return null;
        }
        host.append(template.content.cloneNode(true));
    }
    const roles = Object.fromEntries(ROLES.map((role) => [role, host.querySelector(`[data-role="${role}"]`)]));
    if (ROLES.some((role) => !roles[role])) {
        log.error('Chat widget template is incomplete.');
        return null;
    }
    return roles;
}
