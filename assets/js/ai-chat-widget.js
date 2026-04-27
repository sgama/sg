/**
 * <ai-chat-widget> — custom element that owns the AI chat dialog.
 *
 * Light-DOM custom element: keeps the existing chat-widget__* CSS in site.css
 * applicable, while moving all chat behaviour, state, and DOM ownership inside
 * a single class with proper lifecycle.
 *
 * Public API (on the element):
 *   .open(), .close(), .toggle(), .setPendingQuestion(text)
 *
 * Events emitted: chat-open, chat-close.
 */
(() => {
    if (customElements.get("ai-chat-widget")) return;

    const STORAGE_KEY = "ai-chat-history";
    const SESSION_OPEN_KEY = "ai-chat-open";
    const API_ENDPOINT = "/api/chat";
    const WELCOME_MESSAGE =
        "Hello! I'm an AI assistant trained on this portfolio. Ask me anything about my projects or background.";

    const TEMPLATE = `
<button class="chat-widget__toggle" data-role="toggle" type="button" aria-label="Ask AI Assistant">
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        <path d="M12 7v6"></path>
        <path d="M9 10h6"></path>
    </svg>
    <span>Ask AI</span>
</button>
<dialog class="chat-widget__window" data-role="window" aria-label="Chat with AI assistant">
    <header class="chat-widget__header">
        <span>Assistant</span>
        <div class="chat-widget__header-actions">
            <button class="chat-widget__header-btn chat-widget__header-btn--clear"
                data-role="clear" type="button" aria-label="Clear History" title="Clear History">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
            </button>
            <button class="chat-widget__header-btn chat-widget__header-btn--close"
                data-role="close" type="button" aria-label="Close Chat">&times;</button>
        </div>
    </header>
    <div class="chat-widget__messages" data-role="messages"></div>
    <form class="chat-widget__input-area" data-role="form">
        <input type="text" class="chat-widget__input" data-role="input" placeholder="Ask a question..."
            aria-label="Question" autocomplete="off">
        <button type="submit" class="chat-widget__send" data-role="send">Send</button>
    </form>
</dialog>
`.trim();

    // ---- Helpers (private to this module) ----

    const normalizeSender = (sender) => (sender === "user" ? "user" : "bot");
    const isNearBottom = (el, threshold = 64) =>
        el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;

    let renderMarkdown = null;
    let markdownLoader = null;
    function loadMarkdown() {
        if (markdownLoader) return markdownLoader;
        markdownLoader = Promise.all([
            import("https://esm.sh/marked@13"),
            import("https://esm.sh/dompurify@3"),
        ])
            .then(([markedMod, purifyMod]) => {
                const marked = markedMod.marked || markedMod.default || markedMod;
                const purify = purifyMod.default || purifyMod;
                marked.setOptions({ gfm: true, breaks: true });
                renderMarkdown = (text) => purify.sanitize(marked.parse(text));
            })
            .catch(() => {
                renderMarkdown = null;
            });
        return markdownLoader;
    }

    function createSafeStore(store, { json = false } = {}) {
        return {
            get(key, fallback) {
                try {
                    const raw = store.getItem(key);
                    if (!json) return raw ?? fallback;
                    return raw ? JSON.parse(raw) : fallback;
                } catch {
                    return fallback;
                }
            },
            set(key, value) {
                try {
                    store.setItem(key, json ? JSON.stringify(value) : value);
                } catch {
                    // Ignore storage failures (blocked, full, private mode).
                }
            },
            remove(key) {
                try {
                    store.removeItem(key);
                } catch {
                    // Ignore.
                }
            },
        };
    }

    function createSseResponseParser(onDelta) {
        let buffer = "";
        const handleLine = (line) => {
            if (!line.startsWith("data: ")) return;
            const dataStr = line.slice(6).trim();
            if (!dataStr || dataStr === "[DONE]") return;
            try {
                const json = JSON.parse(dataStr);
                if (json.response) onDelta(json.response);
            } catch { /* ignore malformed line */ }
        };
        return {
            push(chunk) {
                buffer += chunk;
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                lines.forEach(handleLine);
            },
            flush() {
                if (!buffer) return;
                handleLine(buffer);
                buffer = "";
            },
        };
    }

    function createRafThrottler(update) {
        let frame = null;
        let pending = "";
        return {
            schedule(next) {
                pending = next;
                if (frame) return;
                frame = requestAnimationFrame(() => {
                    frame = null;
                    update(pending);
                });
            },
            cancel() {
                if (!frame) return;
                cancelAnimationFrame(frame);
                frame = null;
            },
        };
    }

    // Vertical swipe-to-close gesture for the mobile takeover.
    class SwipeDownDismiss {
        constructor({ minDistance = 100, onSwipe, shouldStartTracking }) {
            this.config = { minDistance };
            this.state = { startY: 0, startTime: 0, tracking: false };
            this.onSwipe = onSwipe ?? (() => {});
            this.shouldStartTracking = shouldStartTracking ?? (() => true);
            this._handlers = null;
        }
        attach(element) {
            if (!element) return;
            const start = (e) => {
                if (!this.shouldStartTracking()) return;
                this.state = { startY: e.touches[0].clientY, startTime: Date.now(), tracking: true };
            };
            const move = (e) => {
                if (!this.state.tracking) return;
                const dy = e.touches[0].clientY - this.state.startY;
                const dx = e.touches[0].clientX - (this.state.startX ?? e.touches[0].clientX);
                if (dy > 0 && Math.abs(dy) > Math.abs(dx)) e.preventDefault();
            };
            const end = (e) => {
                if (!this.state.tracking) return;
                const dy = e.changedTouches[0].clientY - this.state.startY;
                const dt = Date.now() - this.state.startTime;
                const fast = dy >= 50 && dt <= 300;
                const long = dy >= this.config.minDistance;
                if (fast || long) this.onSwipe();
                this.state.tracking = false;
            };
            const cancel = () => { this.state.tracking = false; };
            element.addEventListener("touchstart", start, { passive: false });
            element.addEventListener("touchmove", move, { passive: false });
            element.addEventListener("touchend", end, { passive: true });
            element.addEventListener("touchcancel", cancel, { passive: true });
            this._handlers = { element, start, move, end, cancel };
        }
        detach() {
            if (!this._handlers) return;
            const { element, start, move, end, cancel } = this._handlers;
            element.removeEventListener("touchstart", start);
            element.removeEventListener("touchmove", move);
            element.removeEventListener("touchend", end);
            element.removeEventListener("touchcancel", cancel);
            this._handlers = null;
        }
    }

    // ---- Custom element ----

    class AiChatWidget extends HTMLElement {
        constructor() {
            super();
            this._abortController = null;
            this._handlers = [];
            this._swipe = null;
            this._pendingQuestion = null;
            this._initialised = false;
            this._safeStorage = createSafeStore(localStorage, { json: true });
            this._safeSession = createSafeStore(sessionStorage);
        }

        // --- Public API ---

        open() {
            if (!this._initialised || !this.dialog) return;
            if (this.dialog.open) {
                this._applyPendingQuestion();
                this._focusInput();
                return;
            }
            this.classList.add("chat-widget--open");
            document.body.classList.add("ai-chat-open");
            if (typeof this.dialog.showModal === "function") {
                this.dialog.showModal();
            } else {
                this.dialog.setAttribute("open", "");
            }
            this._applyPendingQuestion();
            this._focusInput();
            this._safeSession.set(SESSION_OPEN_KEY, "true");
            this.dispatchEvent(new CustomEvent("chat-open", { bubbles: true }));
        }

        _focusInput() {
            if (!this.input) return;
            // Wait one frame so display:flex/[open] has propagated and the input
            // is actually focusable; place caret at end of any pending text.
            requestAnimationFrame(() => {
                if (!this.dialog?.open) return;
                this.input.focus({ preventScroll: true });
                const end = this.input.value.length;
                try { this.input.setSelectionRange(end, end); } catch { /* ignore */ }
            });
        }

        close() {
            if (!this._initialised || !this.dialog) return;
            if (!this.dialog.open && !this.dialog.hasAttribute("open")) return;
            
            this.classList.remove("chat-widget--open");
            document.body.classList.remove("ai-chat-open");
            
            // The CSS uses `transition-behavior: allow-discrete` which means modern
            // browsers (Chrome 117+, Safari 17.4+) will animate the dialog out even
            // after close() is called. Older browsers will close instantly.
            if (typeof this.dialog.close === "function") {
                this.dialog.close();
            } else {
                this.dialog.removeAttribute("open");
            }
            
            this._safeSession.remove(SESSION_OPEN_KEY);
            this._cancelInflight();
            this.dispatchEvent(new CustomEvent("chat-close", { bubbles: true }));
        }

        toggle() {
            if (!this._initialised || !this.dialog) return;
            if (this.dialog.open) this.close();
            else this.open();
        }

        setPendingQuestion(text) {
            this._pendingQuestion = text;
            if (this.dialog?.open) this._applyPendingQuestion();
        }

        // --- Lifecycle ---

        connectedCallback() {
            if (this._initialised) return;
            this.classList.add("chat-widget");
            this.innerHTML = TEMPLATE;
            this._cacheElements();
            this._bindEvents();
            this._loadHistory();

            // Restore previous session's open state.
            if (this._safeSession.get(SESSION_OPEN_KEY) === "true") {
                this.open();
            }

            // Pre-warm the markdown renderer so the first stream renders formatted.
            loadMarkdown();
            this._initialised = true;
        }

        disconnectedCallback() {
            this._cancelInflight();
            this._handlers.forEach(({ element, event, handler }) =>
                element.removeEventListener(event, handler)
            );
            this._handlers.length = 0;
            this._swipe?.detach();
            this._swipe = null;
            document.body.classList.remove("ai-chat-open");
            this._initialised = false;
        }

        // --- Internals ---

        _cacheElements() {
            const q = (role) => this.querySelector(`[data-role="${role}"]`);
            this.toggleBtn = q("toggle");
            this.dialog = q("window");
            this.closeBtn = q("close");
            this.clearBtn = q("clear");
            this.form = q("form");
            this.input = q("input");
            this.sendBtn = q("send");
            this.messages = q("messages");
        }

        _addHandler(element, event, handler, options) {
            if (!element) return;
            const bound = handler.bind(this);
            element.addEventListener(event, bound, options);
            this._handlers.push({ element, event, handler: bound });
        }

        _bindEvents() {
            this._addHandler(this.toggleBtn, "click", () => this.toggle());
            this._addHandler(this.closeBtn, "click", (event) => {
                event.stopPropagation();
                this.close();
            });
            this._addHandler(this.clearBtn, "click", () => this._handleClearHistory());
            this._addHandler(this.form, "submit", (event) => this._handleSubmit(event));

            // Native dialog close — covers ESC, .close() from anywhere.
            this._addHandler(this.dialog, "close", () => {
                this.classList.remove("chat-widget--open");
                document.body.classList.remove("ai-chat-open");
                this._safeSession.remove(SESSION_OPEN_KEY);
                this._cancelInflight();
            });

            // Keyboard shortcuts on the input.
            this._addHandler(this.input, "keydown", (event) => {
                if (event.key === "Escape") {
                    this.close();
                } else if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    this.form?.requestSubmit();
                }
            });

            // Swipe-down-to-close on mobile (only when scrolled to top of messages).
            this._swipe = new SwipeDownDismiss({
                onSwipe: () => this.close(),
                shouldStartTracking: () =>
                    this.messages ? this.messages.scrollTop === 0 : false,
            });
            this._swipe.attach(this.dialog);
        }

        // --- History ---

        _getHistory() {
            return this._safeStorage.get(STORAGE_KEY, []);
        }

        _saveMessage(msg) {
            const history = this._getHistory();
            history.push(msg);
            this._safeStorage.set(STORAGE_KEY, history);
        }

        _ensureWelcome() {
            const history = this._getHistory();
            if (history.length) return history;
            const welcome = { text: WELCOME_MESSAGE, sender: "bot" };
            this._saveMessage(welcome);
            return [welcome];
        }

        _loadHistory() {
            const history = this._ensureWelcome();
            const fragment = document.createDocumentFragment();
            history.forEach((msg) => {
                fragment.appendChild(this._buildMessageEl(msg.text, msg.sender ?? "bot"));
            });
            this.messages?.appendChild(fragment);
            requestAnimationFrame(() => {
                if (this.messages) this.messages.scrollTop = this.messages.scrollHeight;
            });
        }

        _handleClearHistory() {
            if (!window.confirm("Delete chat history?")) return;
            this._safeStorage.remove(STORAGE_KEY);
            if (this.messages) this.messages.innerHTML = "";
            this._loadHistory();
        }

        // --- Pending question (set externally via setPendingQuestion or dataset) ---

        _applyPendingQuestion() {
            if (!this._pendingQuestion || !this.input) return;
            this.input.value = this._pendingQuestion;
            this._pendingQuestion = null;
        }

        // --- Message rendering ---

        _writeMessageContent(el, text, sender) {
            if (sender === "bot" && renderMarkdown) {
                const html = renderMarkdown(text);
                if (el.innerHTML !== html) el.innerHTML = html;
            } else if (el.textContent !== text) {
                el.textContent = text;
            }
        }

        _buildMessageEl(text, sender) {
            const div = document.createElement("div");
            const normalized = normalizeSender(sender);
            div.classList.add("chat-widget__message", `chat-widget__message--${normalized}`);
            div.setAttribute("role", normalized === "bot" ? "status" : "article");
            div.setAttribute("aria-live", normalized === "bot" ? "polite" : "off");
            this._writeMessageContent(div, text, normalized);
            return div;
        }

        _addMessage(text, sender) {
            if (!this.messages) return null;
            const shouldScroll = isNearBottom(this.messages);
            const div = this._buildMessageEl(text, sender);
            this.messages.appendChild(div);
            if (shouldScroll) {
                requestAnimationFrame(() => {
                    this.messages.scrollTop = this.messages.scrollHeight;
                });
            }
            return div;
        }

        _updateMessage(messageEl, text, forceScroll = false) {
            if (!messageEl) return;
            const sender = messageEl.classList.contains("chat-widget__message--user")
                ? "user"
                : "bot";
            if (!text) {
                messageEl.classList.add("chat-widget__message--loading");
            } else {
                messageEl.classList.remove("chat-widget__message--loading");
            }
            this._writeMessageContent(messageEl, text || "...", sender);
            if (this.messages && (forceScroll || isNearBottom(this.messages))) {
                requestAnimationFrame(() => {
                    this.messages.scrollTop = this.messages.scrollHeight;
                });
            }
        }

        _setInputDisabled(disabled) {
            if (this.input) this.input.disabled = disabled;
            if (this.sendBtn) {
                this.sendBtn.disabled = disabled;
                this.sendBtn.setAttribute("aria-busy", disabled ? "true" : "false");
            }
        }

        _cancelInflight() {
            if (this._abortController) {
                this._abortController.abort();
                this._abortController = null;
            }
        }

        // --- Submit & streaming ---

        async _handleSubmit(event) {
            event.preventDefault();
            const text = (this.input?.value ?? "").trim();
            if (!text) return;

            this._addMessage(text, "user");
            this._saveMessage({ text, sender: "user" });

            if (this.input) this.input.value = "";
            this._setInputDisabled(true);

            this._abortController = new AbortController();
            let botMessage = null;
            const throttler = createRafThrottler((nextText) => {
                this._updateMessage(botMessage, nextText, true);
            });

            try {
                botMessage = this._addMessage("", "bot");
                const accumulated = await this._streamChat(text, (next) => throttler.schedule(next), this._abortController.signal);
                throttler.cancel();
                this._updateMessage(botMessage, accumulated, true);
                if (accumulated) this._saveMessage({ text: accumulated, sender: "bot" });
            } catch (error) {
                if (error.name === "AbortError") {
                    if (botMessage) botMessage.remove();
                } else {
                    if (botMessage && !botMessage.textContent) botMessage.remove();
                    const offline = !navigator.onLine || /offline/i.test(error.message ?? "");
                    const errorMsg = offline
                        ? "You appear to be offline. Please check your connection."
                        : "Sorry, I'm having trouble connecting. Please try again.";
                    this._addMessage(errorMsg, "bot");
                }
            } finally {
                throttler.cancel();
                this._abortController = null;
                this._setInputDisabled(false);
                this.input?.focus();
            }
        }

        async _streamChat(query, onUpdate, signal) {
            if (!navigator.onLine) throw new Error("Offline");

            const response = await fetch(API_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query }),
                signal,
            });
            if (!response.ok || !response.body) {
                const errorText = await response.text().catch(() => "Unknown error");
                throw new Error(`Network error: ${response.status} - ${errorText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let accumulated = "";
            const parser = createSseResponseParser((delta) => {
                accumulated += delta;
                onUpdate(accumulated, delta);
            });

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    parser.push(decoder.decode(value, { stream: true }));
                }
                parser.push(decoder.decode());
                parser.flush();
            } finally {
                reader.releaseLock();
            }
            return accumulated;
        }
    }

    customElements.define("ai-chat-widget", AiChatWidget);
})();
