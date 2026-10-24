// <ai-chat-widget>: the composition root of the assistant.
//
//   model/  conversation state, history storage and the streaming protocol (no DOM)
//   view/   dialog, composer, transcript and message decorators (DOM only, no conversation logic)
//   this    builds both, subscribes to the conversation's events and forwards user intent to it
import { createStore } from './chat/model/history.js';
import { createConversation, WELCOME_MESSAGE } from './chat/model/conversation.js';
import { hydrate } from './chat/view/roles.js';
import { createDialog } from './chat/view/dialog.js';
import { createComposer } from './chat/view/composer.js';
import { createTranscript } from './chat/view/transcript.js';
import { createStarters } from './chat/view/starters.js';
import { evidenceDecorator, metricsDecorator, retryDecorator } from './chat/view/decorators.js';
import { createChatScroller } from './chat/view/scroll.js';
import { createMessageRenderer } from './chat/view/markdown-renderer.js';

const STARTERS = [
    ['Summarize his experience', "Summarize Samson's recent engineering experience."],
    ['Show a technical project', 'Show me a technical project Samson built and explain its architecture.'],
    ['What has he built at scale?', 'What has Samson built or operated at scale?'],
    ['How does this assistant work?', "How does Samson's portfolio AI assistant work?"],
];

class AiChatWidget extends HTMLElement {
    #chat = createConversation({ storage: createStore(() => localStorage, { json: true }) });
    #session = createStore(() => sessionStorage);
    #renderer = null;
    #lifecycle = null;
    #unsubscribe = null;
    #roles = null;
    #composer = null;
    #dialog = null;
    #scroller = null;
    #transcript = null;
    #pendingQuestion = null;

    connectedCallback() {
        if (this.#lifecycle) return;
        const roles = hydrate(this);
        if (!roles) return;
        this.#roles = roles;
        this.#lifecycle = new AbortController();
        const { signal } = this.#lifecycle;
        this.#renderer ??= this.#createRenderer();
        this.#composer = createComposer({
            roles,
            signal,
            isBusy: () => this.#chat.busy,
            onSubmit: (text, retry) => this.#ask(text, retry),
            onStop: () => this.#chat.cancel(),
            onClear: () => {
                this.#chat.clear();
                this.#scroller.changed(true);
            },
        });
        this.#dialog = createDialog({
            host: this,
            roles,
            session: this.#session,
            signal,
            beforeOpen: () => this.#prepare(),
            afterOpen: () => {
                this.#applyPendingQuestion();
                this.#scroller.changed(true);
            },
            afterClose: () => this.#chat.cancel(),
        });
        this.#unsubscribe = this.#chat.subscribe((event) => this.#render(event));
        this.#composer.setBusy(false);
        this.#dialog.restore();
    }

    disconnectedCallback() {
        this.#chat.cancel();
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        this.#lifecycle?.abort();
        this.#lifecycle = null;
        this.#transcript?.destroy();
        this.#scroller?.destroy();
        this.#transcript = this.#scroller = null;
        this.#dialog?.destroy();
        this.#dialog = null;
    }

    open() {
        this.#dialog?.open();
    }

    close() {
        this.#dialog?.close();
    }

    toggle() {
        this.#dialog?.toggle();
    }

    /** Prefills the input the next time the dialog is open (used by the page's chat trigger buttons). */
    setPendingQuestion(text) {
        this.#pendingQuestion = String(text);
        if (this.#dialog?.isOpen) this.#applyPendingQuestion();
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

    // History and transcript work is deferred to the first open so an idle page pays nothing for it.
    #prepare() {
        if (this.#transcript) return;
        const { signal } = this.#lifecycle;
        const { messages, transcript, latest } = this.#roles;
        this.#scroller = createChatScroller(messages, transcript, latest, { isOpen: () => this.#dialog.isOpen, signal });
        this.#transcript = createTranscript({
            container: transcript,
            renderer: this.#renderer,
            scroller: this.#scroller,
            activeRequest: () => this.#chat.activeRequest,
            decorators: [
                evidenceDecorator({ renderer: this.#renderer }),
                retryDecorator({ retryFor: (message) => this.#chat.retryFor(message), onRetry: (retry) => this.#composer.retry(retry) }),
                metricsDecorator(),
            ],
        });
        this.#chat.load();
        this.#renderer.load().then(() => {
            if (signal.aborted || !this.isConnected || !this.#renderer.ready) return;
            this.#transcript?.refresh();
        });
    }

    #applyPendingQuestion() {
        if (this.#pendingQuestion === null) return;
        this.#composer.prefill(this.#pendingQuestion);
        this.#pendingQuestion = null;
    }

    #ask(text, retry) {
        this.#scroller.changed(true);
        this.#transcript.clearStarters();
        return Boolean(this.#chat.ask(text, { retry }));
    }

    /** Maps one conversation event to view updates. */
    #render(event) {
        const transcript = this.#transcript;
        switch (event.type) {
            case 'history:reset': {
                const messages = this.#chat.messages;
                const fresh = messages.length === 1 && messages[0].text === WELCOME_MESSAGE;
                transcript?.reset(messages, fresh ? [createStarters(STARTERS, (query) => this.#composer.ask(query))] : []);
                break;
            }
            case 'message:add':
                transcript?.add(event.message);
                break;
            case 'message:update':
                transcript?.update(event.message);
                break;
            case 'busy':
                this.#composer.setBusy(event.busy);
                if (event.busy) transcript?.startProgress();
                else transcript?.stopProgress();
                break;
            case 'stage':
                this.#composer.setStatus(event.request.stage);
                transcript?.stage();
                break;
            case 'answer':
                transcript?.answer(event.request);
                break;
            case 'status':
                this.#composer.setStatus(event.text);
                break;
        }
    }
}

if (!customElements.get('ai-chat-widget')) customElements.define('ai-chat-widget', AiChatWidget);
