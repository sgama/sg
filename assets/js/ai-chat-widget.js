import { createStore, SESSION_OPEN_KEY } from './chat/history.js';
import { createChatScroller } from './chat/scroll.js';
import { createMessageRenderer } from './chat/render.js';
import { createMetricsFooter } from './chat/metrics.js';
import { publicEvidence, createEvidencePanel } from './chat/evidence.js';
import { createChatController, WELCOME_MESSAGE } from './chat/controller.js';

const STARTERS = [
    ['Summarize his experience', "Summarize Samson's recent engineering experience."],
    ['Show a technical project', 'Show me a technical project Samson built and explain its architecture.'],
    ['What has he built at scale?', 'What has Samson built or operated at scale?'],
    ['How does this assistant work?', "How does Samson's portfolio AI assistant work?"],
];
const ROLES = ['toggle', 'window', 'close', 'clear', 'form', 'input', 'send', 'stop', 'messages', 'transcript', 'latest', 'status'];

/**
 * Thin view for the assistant. Conversation and request state live in the controller
 * (chat/controller.js); this class renders its events and forwards user intent to it.
 */
class AiChatWidget extends HTMLElement {
    #dom;
    #events = null;
    #scroller;
    #pendingQuestion = null;
    #controller = createChatController({ storage: createStore(() => localStorage, { json: true }) });
    #unsubscribe = null;
    #session = createStore(() => sessionStorage);
    #renderer = null;
    #opener = null;
    #openFrame = null;
    #conversationReady = false;
    #ticker = null;
    #frame = null;
    #elementOf = new WeakMap();
    #messageOf = new WeakMap();

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
        this.#dom = Object.fromEntries(ROLES.map((role) => [role, this.querySelector(`[data-role="${role}"]`)]));
        if (ROLES.some((role) => !this.#dom[role])) {
            console.error('Chat widget template is incomplete.');
            return;
        }
        this.#events = new AbortController();
        this.#renderer ??= this.#createRenderer();
        this.#unsubscribe = this.#controller.subscribe((event) => this.#render(event));
        this.#bindEvents();
        this.#setBusy(false);
        if (this.#session.get(SESSION_OPEN_KEY) === 'true') this.open();
    }

    // Markdown and diagram libraries are separate build entries, referenced by URL from data attributes.
    // A missing URL is a misconfiguration: the loader rejects, so the renderer warns and shows plain text.
    #createRenderer() {
        const { markdownSrc, mermaidSrc } = this.dataset ?? {};
        return createMessageRenderer({
            loadModules: async () => {
                if (!markdownSrc) throw new Error('Markdown library URL is not configured.');
                const { marked, DOMPurify } = await import(markdownSrc);
                return [{ marked }, { default: DOMPurify }];
            },
            loadMermaid: () => {
                if (!mermaidSrc) return Promise.reject(new Error('Mermaid library URL is not configured.'));
                return import(mermaidSrc);
            },
        });
    }

    disconnectedCallback() {
        this.#controller.cancel();
        this.#unsubscribe?.();
        this.#unsubscribe = null;
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

    #initialiseConversation() {
        if (this.#conversationReady) return;
        this.#conversationReady = true;
        this.#scroller = createChatScroller(this.#dom.messages, this.#dom.transcript, this.#dom.latest, {
            isOpen: () => this.#dom.window.open,
            signal: this.#events.signal,
        });
        this.#controller.load();
        const events = this.#events;
        this.#renderer.load().then(() => {
            if (events.signal.aborted || !this.isConnected || !this.#renderer.ready) return;
            this.#dom.transcript.querySelectorAll('.message--bot').forEach((element) => this.#writeMessage(element, element.dataset.rawText, 'bot'));
            this.#scroller.changed();
        });
    }

    #afterClose() {
        if (!this.classList.contains('is-open')) return;
        this.classList.remove('is-open');
        document.body.classList.remove('ai-chat-open');
        this.#dom.toggle.setAttribute('aria-expanded', 'false');
        this.#session.remove(SESSION_OPEN_KEY);
        this.#controller.cancel();
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
                if (!this.#controller.busy) this.#dom.form.requestSubmit();
            }
        });
        listen('form', 'submit', (event) => {
            event.preventDefault();
            this.#submit();
        });
        listen('stop', 'click', () => {
            this.#controller.cancel();
            this.#dom.input.focus({ preventScroll: true });
        });
        listen('clear', 'click', () => {
            if (!window.confirm('Delete chat history on this device?')) return;
            this.#controller.clear();
            this.#scroller.changed(true);
            this.#dom.input.focus({ preventScroll: true });
        });
    }

    #applyPendingQuestion() {
        if (this.#pendingQuestion === null) return;
        this.#dom.input.value = this.#pendingQuestion.slice(0, this.#dom.input.maxLength);
        this.#pendingQuestion = null;
    }

    #submit(retry = null) {
        const text = this.#dom.input.value.trim();
        if (!text || this.#controller.busy || !this.#dom.form.reportValidity()) return;
        this.#scroller.changed(true);
        this.#dom.transcript.querySelectorAll('.chat-starters').forEach((element) => element.remove());
        if (!this.#controller.ask(text, { retry })) return;
        this.#dom.input.value = '';
        this.#dom.input.focus({ preventScroll: true });
    }

    /** Maps one controller event to DOM updates. */
    #render(event) {
        switch (event.type) {
            case 'history:reset':
                this.#renderHistory();
                break;
            case 'message:add':
                this.#dom.transcript.append(this.#buildMessage(event.message));
                this.#scroller.changed();
                break;
            case 'message:update':
                this.#writeMessage(this.#elementOf.get(event.message), event.message.text, 'bot');
                break;
            case 'busy':
                this.#setBusy(event.busy);
                if (event.busy) this.#startTicker();
                else this.#stopTicker();
                break;
            case 'stage':
                this.#dom.status.textContent = event.request.stage;
                this.#showElapsed();
                break;
            case 'answer':
                this.#scheduleAnswerWrite(event.request);
                break;
            case 'status':
                this.#dom.status.textContent = event.text;
                break;
        }
    }

    #startTicker() {
        this.#ticker = setInterval(() => this.#showElapsed(), 1000);
        this.#showElapsed();
    }

    #stopTicker() {
        clearInterval(this.#ticker);
        this.#ticker = null;
        if (this.#frame !== null) cancelAnimationFrame(this.#frame);
        this.#frame = null;
    }

    #showElapsed() {
        const active = this.#controller.activeRequest;
        if (!active || active.answer) return;
        const label = `${active.stage} · ${Math.floor(active.elapsedMs / 1000)}s elapsed`;
        this.#elementOf.get(active.message).textContent = label;
        this.#scroller.changed();
    }

    // Streamed answers are coalesced to one DOM write per animation frame.
    #scheduleAnswerWrite(request) {
        clearInterval(this.#ticker);
        if (this.#frame !== null) return;
        this.#frame = requestAnimationFrame(() => {
            this.#frame = null;
            const current = this.#controller.activeRequest;
            if (current?.id === request.id) this.#writeMessage(this.#elementOf.get(current.message), current.answer, 'bot');
        });
    }

    #renderHistory() {
        const messages = this.#controller.messages;
        this.#dom.transcript.replaceChildren(...messages.map((message) => this.#buildMessage(message)));
        if (messages.length === 1 && messages[0].text === WELCOME_MESSAGE) this.#dom.transcript.append(this.#buildStarters());
        this.#scroller.changed();
    }

    #buildStarters() {
        const starters = document.createElement('div');
        starters.classList.add('chat-starters');
        for (const [label, query] of STARTERS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.addEventListener('click', () => {
                if (this.#controller.busy) return;
                this.#dom.input.value = query.slice(0, this.#dom.input.maxLength);
                this.#dom.form.requestSubmit();
            });
            starters.append(button);
        }
        return starters;
    }

    #writeMessage(element, text, sender) {
        this.#renderer.write(element, text, sender);
        const message = this.#messageOf.get(element);
        const evidence = sender === 'bot' && message?.evidence ? publicEvidence(message.evidence) : null;
        if (evidence?.length) element.append(createEvidencePanel(evidence, document, this.#renderer));
        const retry = message ? this.#controller.retryFor(message) : null;
        if (retry) {
            const button = document.createElement('button');
            button.type = 'button';
            button.classList.add('chat-retry');
            button.textContent = 'Retry';
            button.addEventListener('click', () => {
                if (this.#controller.busy) return;
                this.#dom.input.value = retry.query;
                this.#submit(retry);
            });
            element.append(button);
        }
        const footer = createMetricsFooter(sender === 'bot' ? message?.metrics : null, document);
        if (footer) element.append(footer);
        this.#scroller.changed();
    }

    #buildMessage(message) {
        const element = document.createElement('div');
        element.classList.add('message', `message--${message.sender}`);
        element.setAttribute('aria-label', message.sender === 'user' ? 'You' : 'Assistant');
        this.#elementOf.set(message, element);
        this.#messageOf.set(element, message);
        this.#writeMessage(element, message.text, message.sender);
        return element;
    }

    #setBusy(busy) {
        this.#dom.send.disabled = busy;
        this.#dom.stop.hidden = !busy;
        this.#dom.send.hidden = busy;
        this.#dom.transcript.setAttribute('aria-busy', String(busy));
        this.#dom.status.textContent = busy ? 'Assistant is responding.' : '';
    }
}

if (!customElements.get('ai-chat-widget')) customElements.define('ai-chat-widget', AiChatWidget);
