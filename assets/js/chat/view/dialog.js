import { SESSION_OPEN_KEY } from '../model/history.js';

/**
 * The launcher and its dialog: open/close state, focus management and session restore.
 * It knows nothing about conversations; the host reacts through the optional hooks.
 */
export function createDialog({ host, roles, session, signal, beforeOpen, afterOpen, afterClose }) {
    const { window: dialog, toggle, close: closeButton, input } = roles;
    let opener = null;
    let frame = null;

    function open() {
        beforeOpen?.();
        if (!dialog.open) {
            opener = document.activeElement;
            dialog.showModal();
            host.classList.add('is-open');
            document.body.classList.add('ai-chat-open');
            toggle.setAttribute('aria-expanded', 'true');
            session.set(SESSION_OPEN_KEY, 'true');
            host.dispatchEvent(new CustomEvent('chat-open', { bubbles: true }));
        }
        afterOpen?.();
        if (frame !== null) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            frame = null;
            // Touch keyboards would cover the transcript the user just opened, so only pointer users are focused.
            if (dialog.open && !globalThis.matchMedia?.('(pointer: coarse)').matches) input.focus({ preventScroll: true });
        });
    }

    function settle() {
        if (!host.classList.contains('is-open')) return;
        host.classList.remove('is-open');
        document.body.classList.remove('ai-chat-open');
        toggle.setAttribute('aria-expanded', 'false');
        session.remove(SESSION_OPEN_KEY);
        afterClose?.();
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        host.dispatchEvent(new CustomEvent('chat-close', { bubbles: true }));
    }

    function close() {
        if (!dialog.open) return;
        dialog.close();
        settle();
    }

    const flip = () => (dialog.open ? close() : open());
    const listen = (target, event, listener) => target.addEventListener(event, listener, { signal });
    listen(toggle, 'click', flip);
    listen(closeButton, 'click', close);
    // A queued close event may arrive after the dialog has already reopened.
    listen(dialog, 'close', () => {
        if (!dialog.open) settle();
    });
    listen(dialog, 'cancel', (event) => {
        event.preventDefault();
        close();
    });
    listen(dialog, 'keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        close();
    });

    return {
        open,
        close,
        toggle: flip,
        get isOpen() {
            return dialog.open;
        },
        /** Reopens the dialog when the previous page view left it open. */
        restore() {
            if (session.get(SESSION_OPEN_KEY) === 'true') open();
        },
        /** Resets launcher state without touching the stored session flag, so a reconnect can restore it. */
        destroy() {
            if (frame !== null) cancelAnimationFrame(frame);
            frame = null;
            toggle.setAttribute('aria-expanded', 'false');
            if (dialog.open) dialog.close();
            host.classList.remove('is-open');
            document.body.classList.remove('ai-chat-open');
        },
    };
}
