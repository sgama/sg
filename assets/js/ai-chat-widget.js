import { createStore, readHistory, STORAGE_KEY, SESSION_OPEN_KEY } from "./chat/history.js";
import { streamAnswer } from "./chat/stream.js";
import { createChatScroller } from "./chat/scroll.js";

const WELCOME_MESSAGE = "Hello! I'm an AI assistant using information from this portfolio. Ask me about my projects or background.";
let renderMarkdown = null;
let markdownLoader = null;

function loadMarkdown() {
    return markdownLoader ??= Promise.all([
        import("https://esm.sh/marked@13"),
        import("https://esm.sh/dompurify@3"),
    ]).then(([markedModule, purifyModule]) => {
        const marked = markedModule.marked;
        const purify = purifyModule.default;
        renderMarkdown = (text) => purify.sanitize(marked.parse(text, { gfm: true, breaks: true }));
    }).catch((error) => {
        console.warn("Chat markdown unavailable; displaying plain text.", error);
    });
}

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
    #storage = createStore(() => localStorage, { json: true });
    #session = createStore(() => sessionStorage);

    connectedCallback() {
        if (this.#events) return;
        if (!this.querySelector('[data-role="window"]')) {
            const template = document.getElementById("ai-chat-template");
            if (!template) {
                console.error("Chat widget template is missing.");
                return;
            }
            this.append(template.content.cloneNode(true));
        }
        const roles = ["toggle", "window", "close", "clear", "form", "input", "send",
            "stop", "messages", "transcript", "latest", "status"];
        this.#dom = Object.fromEntries(roles.map((role) => [role, this.querySelector(`[data-role="${role}"]`)]));
        if (roles.some((role) => !this.#dom[role])) {
            console.error("Chat widget template is incomplete.");
            return;
        }
        this.#events = new AbortController();
        this.#bindEvents();
        this.#setBusy(false);
        if (this.#session.get(SESSION_OPEN_KEY) === "true") this.open();
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
        loadMarkdown().then(() => {
            if (events.signal.aborted || !this.isConnected || !renderMarkdown) return;
            this.#dom.transcript.querySelectorAll(".message--bot").forEach((element) =>
                this.#writeMessage(element, element.dataset.rawText, "bot"));
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
        if (this.#dom?.window.open) this.#dom.window.close();
        this.classList.remove("is-open");
        document.body.classList.remove("ai-chat-open");
    }

    open() {
        if (!this.#events) return;
        this.#initialiseConversation();
        const dialog = this.#dom.window;
        if (!dialog.open) {
            this.#opener = document.activeElement;
            dialog.show();
            this.classList.add("is-open");
            document.body.classList.add("ai-chat-open");
            this.#dom.toggle.setAttribute("aria-expanded", "true");
            this.#session.set(SESSION_OPEN_KEY, "true");
            this.dispatchEvent(new CustomEvent("chat-open", { bubbles: true }));
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
        if (!this.classList.contains("is-open")) return;
        this.classList.remove("is-open");
        document.body.classList.remove("ai-chat-open");
        this.#dom.toggle.setAttribute("aria-expanded", "false");
        this.#session.remove(SESSION_OPEN_KEY);
        this.#cancelRequest();
        if (this.#opener?.isConnected) this.#opener.focus({ preventScroll: true });
        this.dispatchEvent(new CustomEvent("chat-close", { bubbles: true }));
    }

    #bindEvents() {
        const { signal } = this.#events;
        const listen = (role, event, listener) => this.#dom[role].addEventListener(event, listener, { signal });
        listen("toggle", "click", () => this.toggle());
        listen("close", "click", () => this.close());
        listen("window", "close", () => {
            // A queued close event may arrive after the dialog has already reopened.
            if (!this.#dom.window.open) this.#afterClose();
        });
        listen("window", "cancel", (event) => {
            event.preventDefault();
            this.close();
        });
        listen("window", "keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                this.close();
            }
        });
        listen("input", "keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                if (!this.#request) this.#dom.form.requestSubmit();
            }
        });
        listen("form", "submit", (event) => {
            event.preventDefault();
            this.#submit();
        });
        listen("stop", "click", () => {
            this.#cancelRequest();
            this.#dom.input.focus({ preventScroll: true });
        });
        listen("clear", "click", () => {
            if (!window.confirm("Delete chat history on this device?")) return;
            this.#cancelRequest();
            this.#history = [{ sender: "bot", text: WELCOME_MESSAGE }];
            this.#persist();
            this.#renderHistory();
            this.#scroller.changed(true);
            this.#dom.status.textContent = "Chat history cleared.";
            this.#dom.input.focus({ preventScroll: true });
        });
    }

    #applyPendingQuestion() {
        if (this.#pendingQuestion === null) return;
        this.#dom.input.value = this.#pendingQuestion.slice(0, this.#dom.input.maxLength);
        this.#pendingQuestion = null;
    }

    #persist() {
        this.#storage.set(STORAGE_KEY, this.#history.filter((message) => message.text.trim()));
    }

    #renderHistory() {
        this.#dom.transcript.replaceChildren(...this.#history.map((message) => this.#buildMessage(message)));
        this.#scroller.changed();
    }

    #writeMessage(element, text, sender) {
        element.dataset.rawText = text;
        element.classList.toggle("message--loading", !text);
        if (sender === "bot" && renderMarkdown && text) {
            element.innerHTML = renderMarkdown(text);
            element.querySelectorAll("a").forEach((link) => {
                link.rel = "noopener noreferrer";
                link.target = "_blank";
            });
        } else {
            element.textContent = text || "Thinking…";
        }
        this.#scroller.changed();
    }

    #buildMessage(message) {
        const element = document.createElement("div");
        element.classList.add("message", `message--${message.sender}`);
        element.setAttribute("aria-label", message.sender === "user" ? "You" : "Assistant");
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
        this.#dom.transcript.setAttribute("aria-busy", String(busy));
        this.#dom.status.textContent = busy ? "Assistant is responding." : "";
    }

    #finishRequest(request, text, status) {
        if (this.#request !== request) return;
        if (request.frame !== null) cancelAnimationFrame(request.frame);
        request.message.text = text;
        this.#writeMessage(request.element, text, "bot");
        this.#persist();
        this.#request = null;
        this.#setBusy(false);
        this.#dom.status.textContent = status;
    }

    #cancelRequest() {
        const request = this.#request;
        if (!request) return;
        request.controller.abort();
        this.#finishRequest(request,
            request.answer ? `${request.answer}\n\n(Response stopped.)` : "Response stopped.",
            "Response stopped.");
    }

    async #submit() {
        const text = this.#dom.input.value.trim();
        if (!text || this.#request || !this.#dom.form.reportValidity()) return;
        this.#scroller.changed(true);
        this.#appendMessage({ text, sender: "user" });
        this.#dom.input.value = "";
        const message = { text: "", sender: "bot" };
        const request = {
            controller: new AbortController(),
            message,
            element: this.#appendMessage(message),
            answer: "",
            frame: null,
        };
        this.#request = request;
        this.#persist();
        this.#setBusy(true);
        this.#dom.input.focus({ preventScroll: true });
        try {
            if (!navigator.onLine) throw new Error("Offline");
            const answer = await streamAnswer(text, {
                signal: request.controller.signal,
                onUpdate: (answer) => {
                    if (this.#request !== request) return;
                    request.answer = answer;
                    if (request.frame !== null) return;
                    request.frame = requestAnimationFrame(() => {
                        request.frame = null;
                        if (this.#request === request) this.#writeMessage(request.element, request.answer, "bot");
                    });
                },
            });
            this.#finishRequest(request, answer, "Response complete.");
        } catch (error) {
            if (this.#request !== request) return;
            console.error("Chat request failed.", error);
            const explanation = !navigator.onLine
                ? "You appear to be offline. Check your connection and try again."
                : "The response could not be completed. Please try again.";
            this.#finishRequest(request,
                request.answer ? `${request.answer}\n\n${explanation}` : explanation,
                explanation);
        }
    }
}

if (!customElements.get("ai-chat-widget")) customElements.define("ai-chat-widget", AiChatWidget);
