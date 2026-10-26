/**
 * The message list. Each message is drawn by the renderer and then extended by `decorators`:
 * functions `(message, sender) => Node | null` whose nodes are appended in order. Evidence,
 * retry and metrics are decorators, so a new per-message feature needs no change here.
 */
export function createTranscript({ container, renderer, scroller, decorators = [], activeRequest, log = console }) {
    const elementOf = new WeakMap();
    const messageOf = new WeakMap();
    let ticker = null;
    let frame = null;

    // Streaming frames skip decorators so open "sources" panels are not rebuilt closed mid-answer.
    function write(element, text, sender, decorate = true) {
        renderer.write(element, text, sender);
        const message = messageOf.get(element);
        for (const extra of decorate ? decorators : []) {
            // One failing decorator must not remove the message or the other decorations.
            try {
                const node = extra(message, sender);
                if (node) element.append(node);
            } catch (error) {
                log.error('Chat message decoration failed.', error);
            }
        }
        scroller.changed();
    }

    function build(message) {
        const element = document.createElement('div');
        element.classList.add('message', `message--${message.sender}`);
        element.setAttribute('role', 'group');
        element.setAttribute('aria-label', message.sender === 'user' ? 'You' : 'Assistant');
        elementOf.set(message, element);
        messageOf.set(element, message);
        write(element, message.text, message.sender);
        return element;
    }

    function showElapsed() {
        const active = activeRequest();
        if (!active || active.answer) return;
        quiet(elementOf.get(active.message));
        elementOf.get(active.message).textContent = `${active.stage} · ${Math.floor(active.elapsedMs / 1000)}s elapsed`;
        scroller.changed();
    }

    // Ticks and streamed frames stay out of the polite log; the finished answer is announced once.
    function quiet(element) {
        element.setAttribute('aria-live', 'off');
    }

    function stopTicker() {
        clearInterval(ticker);
        ticker = null;
    }

    return {
        /** Replaces the whole conversation; `extras` are nodes appended after it (for example starters). */
        reset(messages, extras = []) {
            container.replaceChildren(...messages.map(build));
            if (extras.length) container.append(...extras);
            scroller.changed();
        },
        add(message) {
            container.append(build(message));
            scroller.changed();
        },
        update(message) {
            const element = elementOf.get(message);
            element.removeAttribute('aria-live');
            write(element, message.text, 'bot');
        },
        /** Redraws assistant messages, for example once the Markdown renderer has finished loading. */
        refresh() {
            container.querySelectorAll('.message--bot').forEach((element) => write(element, element.dataset.rawText, 'bot'));
            scroller.changed();
        },
        clearStarters() {
            container.querySelectorAll('.chat-starters').forEach((element) => element.remove());
        },
        /** Shows the elapsed-time placeholder until the first answer text arrives. */
        startProgress() {
            ticker = setInterval(showElapsed, 1000);
            showElapsed();
        },
        stopProgress() {
            stopTicker();
            if (frame !== null) cancelAnimationFrame(frame);
            frame = null;
        },
        stage: showElapsed,
        /** Streamed answers are coalesced to one DOM write per animation frame. */
        answer(request) {
            stopTicker();
            if (frame !== null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                const current = activeRequest();
                if (current?.id !== request.id) return;
                quiet(elementOf.get(current.message));
                write(elementOf.get(current.message), current.answer, 'bot', false);
            });
        },
        destroy() {
            this.stopProgress();
        },
    };
}

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
