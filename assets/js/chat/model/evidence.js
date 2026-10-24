export function publicEvidence(value) {
    if (!Array.isArray(value)) throw new Error('Invalid retrieved evidence');
    return value
        .filter(
            (item) =>
                item &&
                typeof item.url === 'string' &&
                /^\/(?!\/)/.test(item.url) &&
                !/[\\\r\n]/.test(item.url) &&
                !/\/_context(?:\/|$)/.test(item.url) &&
                typeof item.text === 'string' &&
                item.text.trim(),
        )
        .map(({ url, title, section, text }) => ({
            url,
            title: typeof title === 'string' ? title : 'Source',
            section: typeof section === 'string' ? section : '',
            text,
        }));
}
