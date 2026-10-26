/**
 * The question form: input, send/stop buttons, status line and the busy state they share.
 * It reports intent through callbacks and never talks to the conversation itself.
 */
export function createComposer({ roles, signal, isBusy, onSubmit, onStop, onClear, confirm = undefined }) {
    const confirmFn = confirm ?? ((message) => (globalThis.window?.confirm ?? globalThis.confirm)?.(message));
    const { form, input, send, stop, clear, status } = roles;
    const focus = () => input.focus({ preventScroll: true });
    const listen = (target, event, listener) => target.addEventListener(event, listener, { signal });
    /** Puts text in the input, truncated to its limit, without sending it. */
    const prefill = (text) => {
        input.value = String(text).slice(0, input.maxLength);
    };

    function submit(retry = null) {
        const text = input.value.trim();
        if (!text || isBusy() || !form.reportValidity()) return;
        if (!onSubmit(text, retry)) return;
        input.value = '';
        focus();
    }

    listen(input, 'keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        if (!isBusy()) form.requestSubmit();
    });
    listen(form, 'submit', (event) => {
        event.preventDefault();
        submit();
    });
    listen(stop, 'click', () => {
        onStop();
        focus();
    });
    listen(clear, 'click', () => {
        if (!confirmFn('Delete chat history on this device?')) return;
        onClear();
        focus();
    });

    return {
        focus,
        prefill,
        /** Sends a canned question, as the starter shortcuts do. */
        ask(question) {
            if (isBusy()) return;
            prefill(question);
            form.requestSubmit();
        },
        /** Resends a failed exchange with the history it originally used. */
        retry(retry) {
            if (isBusy()) return;
            input.value = retry.query;
            submit(retry);
        },
        setBusy(busy) {
            send.disabled = busy;
            stop.hidden = !busy;
            send.hidden = busy;
            status.textContent = busy ? 'Assistant is responding.' : '';
        },
        setStatus(text) {
            // Stage labels lead with an emoji; screen readers would speak its name.
            status.textContent = String(text).replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '');
        },
    };
}
