import { apiHistory, createStore, readHistory, STORAGE_KEY, SESSION_OPEN_KEY } from './chat/history.js';
import { streamAnswer } from './chat/stream.js';
import { createChatScroller } from './chat/scroll.js';
import { messageRenderer } from './chat/render.js';
import { formatResponseMetrics, createMetricsFooter } from './chat/metrics.js';
import { publicEvidence, createEvidencePanel } from './chat/evidence.js';

const WELCOME_MESSAGE = "Hello! I'm an AI assistant using information from this portfolio. Ask me about my projects or background.";
class AiChatWidget extends HTMLElement {
    #dom;
    #events;
    #scroller;
    #request = null;
    #history = [];
    #pendingQuestion = null;
    #opener = null;
    #openFrame = null;
    #conversationReady = false;
    #metrics = new WeakMap();
    #evidence = new WeakMap();
    #retries = new WeakMap();
    #storage = createStore(() => localStorage, { json: true });
    #session = createStore(() => sessionStorage);

    connectedCallback() {
        if (this.#events) return;
        if (!this.querySelector('[data-role="window"]')) {
            const template = document.getElementById('ai-chat-template');
            if (!template) {
                console.error('Chat widget template is missing.');
                return;
            }
            this.append(template.content.cloneNode(true));
        }
        const roles = ['toggle', 'window', 'close', 'clear', 'form', 'input', 'send', 'stop', 'messages', 'transcript', 'latest', 'status'];
        this.#dom = Object.fromEntries(roles.map((role) => [role, this.querySelector(`[data-role="${role}"]`)]));
        if (roles.some((role) => !this.#dom[role])) {
            console.error('Chat widget template is incomplete.');
            return;
        }
        this.#events = new AbortController();
        this.#bindEvents();
        this.#setBusy(false);
        if (this.#session.get(SESSION_OPEN_KEY) === 'true') this.open();
    }

    #initialiseConversation() {
        if (this.#conversationReady) return;
        this.#conversationReady = true;
        this.#scroller = createChatScroller(this.#dom.messages, this.#dom.transcript, this.#dom.latest, {
            isOpen: () => this.#dom.window.open,
            signal: this.#events.signal,
        });
        this.#history = readHistory(this.#storage, WELCOME_MESSAGE);
        this.#renderHistory();
        const events = this.#events;
        messageRenderer.load().then(() => {
            if (events.signal.aborted || !this.isConnected || !messageRenderer.ready) return;
            this.#dom.transcript.querySelectorAll('.message--bot').forEach((element) => this.#writeMessage(element, element.dataset.rawText, 'bot'));
            this.#scroller.changed();
        });
    }

    disconnectedCallback() {
        this.#cancelRequest();
        this.#events?.abort();
        this.#events = null;
        this.#scroller?.destroy();
        this.#conversationReady = false;
        if (this.#openFrame !== null) cancelAnimationFrame(this.#openFrame);
        this.#openFrame = null;
        this.#dom?.toggle?.setAttribute('aria-expanded', 'false');
        if (this.#dom?.window.open) this.#dom.window.close();
        this.classList.remove('is-open');
        document.body.classList.remove('ai-chat-open');
    }

    open() {
        if (!this.#events) return;
        this.#initialiseConversation();
        const dialog = this.#dom.window;
        if (!dialog.open) {
            this.#opener = document.activeElement;
            dialog.show();
            this.classList.add('is-open');
            document.body.classList.add('ai-chat-open');
            this.#dom.toggle.setAttribute('aria-expanded', 'true');
            this.#session.set(SESSION_OPEN_KEY, 'true');
            this.dispatchEvent(new CustomEvent('chat-open', { bubbles: true }));
        }
        this.#applyPendingQuestion();
        this.#scroller.changed(true);
        if (this.#openFrame !== null) cancelAnimationFrame(this.#openFrame);
        this.#openFrame = requestAnimationFrame(() => {
            this.#openFrame = null;
            if (dialog.open) this.#dom.input.focus({ preventScroll: true });
        });
    }

    close() {
        if (!this.#dom?.window.open) return;
        this.#dom.window.close();
        this.#afterClose();
    }

    toggle() {
        this.#dom?.window.open ? this.close() : this.open();
    }

    setPendingQuestion(text) {
        this.#pendingQuestion = String(text);
        if (this.#dom?.window.open) this.#applyPendingQuestion();
    }

    #afterClose() {
        if (!this.classList.contains('is-open')) return;
        this.classList.remove('is-open');
        document.body.classList.remove('ai-chat-open');
        this.#dom.toggle.setAttribute('aria-expanded', 'false');
        this.#session.remove(SESSION_OPEN_KEY);
        this.#cancelRequest();
        if (this.#opener?.isConnected) this.#opener.focus({ preventScroll: true });
        this.dispatchEvent(new CustomEvent('chat-close', { bubbles: true }));
    }

    #bindEvents() {
        const { signal } = this.#events;
        const listen = (role, event, listener) => this.#dom[role].addEventListener(event, listener, { signal });
        listen('toggle', 'click', () => this.toggle());
        listen('close', 'click', () => this.close());
        listen('window', 'close', () => {
            // A queued close event may arrive after the dialog has already reopened.
            if (!this.#dom.window.open) this.#afterClose();
        });
        listen('window', 'cancel', (event) => {
            event.preventDefault();
            this.close();
        });
        listen('window', 'keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                this.close();
            }
        });
        listen('input', 'keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                if (!this.#request) this.#dom.form.requestSubmit();
            }
        });
        listen('form', 'submit', (event) => {
            event.preventDefault();
            this.#submit();
        });
        listen('stop', 'click', () => {
            this.#cancelRequest();
            this.#dom.input.focus({ preventScroll: true });
        });
        listen('clear', 'click', () => {
            if (!window.confirm('Delete chat history on this device?')) return;
            this.#cancelRequest();
            this.#history = [{ sender: 'bot', text: WELCOME_MESSAGE }];
            this.#persist();
            this.#renderHistory();
            this.#scroller.changed(true);
            this.#dom.status.textContent = 'Chat history cleared.';
            this.#dom.input.focus({ preventScroll: true });
        });
    }

    #applyPendingQuestion() {
        if (this.#pendingQuestion === null) return;
        this.#dom.input.value = this.#pendingQuestion.slice(0, this.#dom.input.maxLength);
        this.#pendingQuestion = null;
    }

    #persist() {
        this.#storage.set(
            STORAGE_KEY,
            this.#history.filter((message) => message.text.trim()),
        );
    }

    #renderHistory() {
        this.#dom.transcript.replaceChildren(...this.#history.map((message) => this.#buildMessage(message)));
        if (this.#history.length === 1 && this.#history[0].text === WELCOME_MESSAGE) {
            const starters = document.createElement('div');
            starters.classList.add('chat-starters');
            for (const [label, query] of [
                ['Summarize his experience', "Summarize Samson's recent engineering experience."],
                ['Show a technical project', 'Show me a technical project Samson built and explain its architecture.'],
                ['What has he built at scale?', 'What has Samson built or operated at scale?'],
                ['How does this assistant work?', "How does Samson's portfolio AI assistant work?"],
            ]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = label;
                button.addEventListener('click', () => {
                    if (this.#request) return;
                    this.#dom.input.value = query.slice(0, this.#dom.input.maxLength);
                    this.#dom.form.requestSubmit();
                });
                starters.append(button);
            }
            this.#dom.transcript.append(starters);
        }
        this.#scroller.changed();
    }

    #writeMessage(element, text, sender) {
        messageRenderer.write(element, text, sender);
        const evidence = sender === 'bot' ? this.#evidence.get(element) : null;
        if (evidence?.length) element.append(createEvidencePanel(evidence, document, messageRenderer));
        const retry = this.#retries.get(element);
        if (retry) {
            const button = document.createElement('button');
            button.type = 'button';
            button.classList.add('chat-retry');
            button.textContent = 'Retry';
            button.addEventListener('click', () => {
                if (this.#request) return;
                this.#dom.input.value = retry.query;
                this.#submit(retry);
            });
            element.append(button);
        }
        const metrics = sender === 'bot' ? this.#metrics.get(element) : null;
        const footer = createMetricsFooter(metrics, document);
        if (footer) element.append(footer);
        this.#scroller.changed();
    }

    #buildMessage(message) {
        const element = document.createElement('div');
        element.classList.add('message', `message--${message.sender}`);
        element.setAttribute('aria-label', message.sender === 'user' ? 'You' : 'Assistant');
        if (message.metrics) this.#metrics.set(element, message.metrics);
        if (message.evidence) this.#evidence.set(element, publicEvidence(message.evidence));
        this.#writeMessage(element, message.text, message.sender);
        return element;
    }

    #appendMessage(message) {
        this.#history.push(message);
        const element = this.#buildMessage(message);
        this.#dom.transcript.append(element);
        this.#scroller.changed();
        return element;
    }

    #setBusy(busy) {
        this.#dom.send.disabled = busy;
        this.#dom.stop.hidden = !busy;
        this.#dom.send.hidden = busy;
        this.#dom.transcript.setAttribute('aria-busy', String(busy));
        this.#dom.status.textContent = busy ? 'Assistant is responding.' : '';
    }

    #finishRequest(request, text, status) {
        if (this.#request !== request) return;
        if (request.frame !== null) cancelAnimationFrame(request.frame);
        clearInterval(request.timer);
        request.message.text = text;
        this.#writeMessage(request.element, text, 'bot');
        this.#persist();
        this.#request = null;
        this.#setBusy(false);
        this.#dom.status.textContent = status;
    }

    #cancelRequest() {
        const request = this.#request;
        if (!request) return;
        request.controller.abort();
        this.#finishRequest(request, request.answer ? `${request.answer}\n\n(Response stopped.)` : 'Response stopped.', 'Response stopped.');
    }

    async #submit(retry = null) {
        const text = this.#dom.input.value.trim();
        if (!text || this.#request || !this.#dom.form.reportValidity()) return;
        this.#scroller.changed(true);
        this.#dom.transcript.querySelectorAll('.chat-starters').forEach((element) => element.remove());
        const history = retry?.history ?? apiHistory(this.#history, WELCOME_MESSAGE);
        this.#appendMessage({ text, sender: 'user' });
        this.#dom.input.value = '';
        const message = { text: '', sender: 'bot' };
        const request = {
            controller: new AbortController(),
            message,
            element: this.#appendMessage(message),
            answer: '',
            frame: null,
            started: performance.now(),
            stage: 'Connecting…',
            history,
            query: text,
        };
        this.#request = request;
        this.#persist();
        this.#setBusy(true);
        const showElapsed = () => {
            if (this.#request !== request || request.answer) return;
            const label = `${request.stage} · ${Math.floor((performance.now() - request.started) / 1000)}s elapsed`;
            request.element.textContent = label;
            this.#scroller.changed();
        };
        request.timer = setInterval(showElapsed, 1000);
        showElapsed();
        this.#dom.input.focus({ preventScroll: true });
        try {
            if (!navigator.onLine) throw new Error('Offline');
            const answer = await streamAnswer(text, {
                history,
                signal: request.controller.signal,
                onProgress: (stage) => {
                    if (this.#request !== request) return;
                    const labels = {
                        rewrite: '🧠 Understanding your follow-up…',
                        embedding: '🧩 Preparing source search…',
                        search: '🔎 Finding sources…',
                        generation: '✍️ Writing answer…',
                    };
                    this.#dom.status.textContent = labels[stage];
                    request.stage = labels[stage];
                    showElapsed();
                },
                onEvidence: (value) => {
                    if (this.#request !== request) return;
                    request.message.evidence = publicEvidence(value);
                    this.#evidence.set(request.element, request.message.evidence);
                },
                onMetrics: (metrics) => {
                    if (this.#request !== request) return;
                    if (!formatResponseMetrics(metrics)) throw new Error('Invalid response metrics');
                    request.message.metrics = metrics;
                    this.#metrics.set(request.element, metrics);
                },
                onUpdate: (answer) => {
                    if (this.#request !== request) return;
                    request.answer = answer;
                    clearInterval(request.timer);
                    if (request.frame !== null) return;
                    request.frame = requestAnimationFrame(() => {
                        request.frame = null;
                        if (this.#request === request) this.#writeMessage(request.element, request.answer, 'bot');
                    });
                },
            });
            this.#finishRequest(request, answer, 'Response complete.');
        } catch (error) {
            if (this.#request !== request) return;
            console.error('Chat request failed.', error);
            const explanation = !navigator.onLine
                ? 'You appear to be offline. Check your connection and try again.'
                : 'The response could not be completed. Please try again.';
            this.#retries.set(request.element, { query: request.query, history: request.history });
            this.#finishRequest(request, request.answer ? `${request.answer}\n\n${explanation}` : explanation, explanation);
        }
    }
}

if (!customElements.get('ai-chat-widget')) customElements.define('ai-chat-widget', AiChatWidget);
