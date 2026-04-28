/**
 * <ai-chat-widget> — custom element that owns the AI chat dialog.
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
    const WELCOME_MESSAGE = "Hello! I'm an AI assistant trained on this portfolio. Ask me anything about my projects or background.";

    // ---- Helpers ----

    const debounce = (func, wait) => {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    };

    const normalizeSender = (sender) => (sender === "user" ? "user" : "bot");
    const isNearBottom = (el, threshold = 64) =>
        el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;

    let renderMarkdown = null;
    let markdownLoader = null;
    const loadMarkdown = () => {
        return markdownLoader ??= Promise.all([
            import("https://esm.sh/marked@13"),
            import("https://esm.sh/dompurify@3"),
        ]).then(([markedMod, purifyMod]) => {
            const marked = markedMod.marked || markedMod.default || markedMod;
            const purify = purifyMod.default || purifyMod;
            marked.setOptions({ gfm: true, breaks: true });
            renderMarkdown = (text) => purify.sanitize(marked.parse(text));
            return true;
        }).catch(() => {
            renderMarkdown = null;
            return false;
        });
    };

    const createSafeStore = (store, { json = false } = {}) => ({
        get: (key, fallback) => {
            try {
                const raw = store.getItem(key);
                if (!json) return raw ?? fallback;
                return raw ? JSON.parse(raw) : fallback;
            } catch { return fallback; }
        },
        set: (key, value) => {
            try { store.setItem(key, json ? JSON.stringify(value) : value); } catch {}
        },
        remove: (key) => {
            try { store.removeItem(key); } catch {}
        },
    });

    const createSseResponseParser = (onDelta) => {
        let buffer = "";
        const handleLine = (line) => {
            if (!line.startsWith("data: ")) return;
            const dataStr = line.slice(6).trim();
            if (!dataStr || dataStr === "[DONE]") return;
            try {
                const json = JSON.parse(dataStr);
                if (json?.response) onDelta(json.response);
            } catch {}
        };
        return {
            push: (chunk) => {
                buffer += chunk;
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                lines.forEach(handleLine);
            },
            flush: () => {
                if (buffer) { handleLine(buffer); buffer = ""; }
            },
        };
    };

    const createRafThrottler = (update) => {
        let frame = null;
        let pending = "";
        return {
            schedule: (next) => {
                pending = next;
                if (!frame) {
                    frame = requestAnimationFrame(() => {
                        frame = null;
                        update(pending);
                    });
                }
            },
            cancel: () => {
                if (frame) { cancelAnimationFrame(frame); frame = null; }
            },
        };
    };

    class SwipeDownDismiss {
        #abortController = null;

        constructor({ minDistance = 100, onSwipe, shouldStartTracking }) {
            this.config = { minDistance };
            this.state = { startY: 0, startTime: 0, tracking: false, startX: 0 };
            this.onSwipe = onSwipe ?? (() => {});
            this.shouldStartTracking = shouldStartTracking ?? (() => true);
        }

        attach(element) {
            if (!element) return;
            this.detach();
            this.#abortController = new AbortController();
            const { signal } = this.#abortController;

            const start = (e) => {
                if (!this.shouldStartTracking()) return;
                this.state = { 
                    startY: e.touches[0].clientY, 
                    startX: e.touches[0].clientX, 
                    startTime: Date.now(), 
                    tracking: true 
                };
            };

            const move = (e) => {
                if (!this.state.tracking) return;
                const dy = e.touches[0].clientY - this.state.startY;
                const dx = e.touches[0].clientX - this.state.startX;
                if (dy > 0 && Math.abs(dy) > Math.abs(dx)) {
                    if (e.cancelable) e.preventDefault();
                }
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

            element.addEventListener("touchstart", start, { passive: false, signal });
            element.addEventListener("touchmove", move, { passive: false, signal });
            element.addEventListener("touchend", end, { passive: true, signal });
            element.addEventListener("touchcancel", cancel, { passive: true, signal });
        }

        detach() {
            this.#abortController?.abort();
            this.#abortController = null;
        }
    }

    // ---- Custom element ----

    class AiChatWidget extends HTMLElement {
        #dom = {};
        #abortController = null;
        #eventAborter = null;
        #swipe = null;
        #pendingQuestion = null;
        #initialised = false;
        #safeStorage = createSafeStore(localStorage, { json: true });
        #safeSession = createSafeStore(sessionStorage);

        // --- Public API ---

        open() {
            if (!this.#initialised || !this.#dom.dialog) return;
            if (this.#dom.dialog.open) {
                this.#applyPendingQuestion();
                this.#focusInput();
                return;
            }
            this.classList.add("chat-widget--open");
            document.body.classList.add("ai-chat-open");
            
            if (typeof this.#dom.dialog.show === "function") {
                this.#dom.dialog.show();
            } else {
                this.#dom.dialog.setAttribute("open", "");
            }
            
            this.#applyPendingQuestion();
            this.#focusInput();
            this.#safeSession.set(SESSION_OPEN_KEY, "true");
            this.dispatchEvent(new CustomEvent("chat-open", { bubbles: true }));
        }

        close() {
            if (!this.#initialised || !this.#dom.dialog) return;
            if (!this.#dom.dialog.open && !this.#dom.dialog.hasAttribute("open")) return;
            
            this.classList.remove("chat-widget--open");
            document.body.classList.remove("ai-chat-open");
            
            if (typeof this.#dom.dialog.close === "function") {
                this.#dom.dialog.close();
            } else {
                this.#dom.dialog.removeAttribute("open");
            }
            
            this.#safeSession.remove(SESSION_OPEN_KEY);
            this.#cancelInflight();
            this.dispatchEvent(new CustomEvent("chat-close", { bubbles: true }));
        }

        toggle() {
            if (!this.#initialised || !this.#dom.dialog) return;
            this.#dom.dialog.open ? this.close() : this.open();
        }

        setPendingQuestion(text) {
            this.#pendingQuestion = text;
            if (this.#dom.dialog?.open) this.#applyPendingQuestion();
        }

        // --- Lifecycle ---

        connectedCallback() {
            if (this.#initialised) return;
            this.classList.add("chat-widget");
            const template = document.getElementById("ai-chat-template");
            if (template) {
                this.appendChild(template.content.cloneNode(true));
            }
            
            const q = (role) => this.querySelector(`[data-role="${role}"]`);
            this.#dom = {
                toggleBtn: q("toggle"),
                dialog: q("window"),
                closeBtn: q("close"),
                clearBtn: q("clear"),
                form: q("form"),
                input: q("input"),
                sendBtn: q("send"),
                messages: q("messages"),
            };

            this.#bindEvents();
            this.#loadHistory();

            if (this.#safeSession.get(SESSION_OPEN_KEY) === "true") {
                this.open();
            }

            loadMarkdown().then((success) => {
                if (success && this.#dom.messages) {
                    const botMessages = this.#dom.messages.querySelectorAll('.chat-widget__message--bot');
                    botMessages.forEach((el) => {
                        if (el.dataset.rawText) {
                            this.#writeMessageContent(el, el.dataset.rawText, "bot");
                        }
                    });
                }
            });
            this.#initialised = true;
        }

        disconnectedCallback() {
            this.#cancelInflight();
            this.#eventAborter?.abort();
            this.#eventAborter = null;
            
            this.#swipe?.detach();
            this.#swipe = null;
            document.body.classList.remove("ai-chat-open");
            this.#initialised = false;
        }

        // --- Internals ---

        #focusInput() {
            if (!this.#dom.input) return;
            requestAnimationFrame(() => {
                if (!this.#dom.dialog?.open) return;
                this.#dom.input.focus({ preventScroll: true });
                const end = this.#dom.input.value.length;
                try { this.#dom.input.setSelectionRange(end, end); } catch {}
            });
        }

        #bindEvents() {
            this.#eventAborter = new AbortController();
            const { signal } = this.#eventAborter;
            const { toggleBtn, closeBtn, clearBtn, form, dialog, input, messages } = this.#dom;

            toggleBtn?.addEventListener("click", () => this.toggle(), { signal });
            
            closeBtn?.addEventListener("click", (e) => {
                e.stopPropagation();
                this.close();
            }, { signal });

            clearBtn?.addEventListener("click", () => {
                if (!window.confirm("Delete chat history?")) return;
                this.#safeStorage.remove(STORAGE_KEY);
                if (messages) messages.innerHTML = "";
                this.#loadHistory();
            }, { signal });

            form?.addEventListener("submit", (e) => this.#handleSubmit(e), { signal });

            dialog?.addEventListener("close", () => {
                this.classList.remove("chat-widget--open");
                document.body.classList.remove("ai-chat-open");
                this.#safeSession.remove(SESSION_OPEN_KEY);
                this.#cancelInflight();
            }, { signal });

            dialog?.addEventListener("keydown", (e) => {
                if (e.key === "Tab") {
                    const focusableElements = dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
                    const firstElement = focusableElements[0];
                    const lastElement = focusableElements[focusableElements.length - 1];

                    if (e.shiftKey) { 
                        if (document.activeElement === firstElement) {
                            lastElement?.focus();
                            e.preventDefault();
                        }
                    } else { 
                        if (document.activeElement === lastElement) {
                            firstElement?.focus();
                            e.preventDefault();
                        }
                    }
                }
            }, { signal });

            input?.addEventListener("keydown", (e) => {
                if (e.key === "Escape") this.close();
                else if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    form?.requestSubmit();
                }
            }, { signal });

            this.#swipe = new SwipeDownDismiss({
                onSwipe: () => this.close(),
                shouldStartTracking: () => !!messages && messages.scrollTop === 0,
            });
            this.#swipe.attach(dialog);
        }

        // --- History ---

        #getHistory() {
            return this.#safeStorage.get(STORAGE_KEY, []);
        }

        #saveMessage(msg) {
            const history = this.#getHistory();
            history.push(msg);
            this.#safeStorage.set(STORAGE_KEY, history);
        }

        #loadHistory() {
            let history = this.#getHistory();
            if (!history.length) {
                history = [{ text: WELCOME_MESSAGE, sender: "bot" }];
                this.#saveMessage(history[0]);
            }
            
            const fragment = document.createDocumentFragment();
            history.forEach(({ text, sender }) => {
                fragment.appendChild(this.#buildMessageEl(text, sender ?? "bot"));
            });
            
            if (this.#dom.messages) {
                this.#dom.messages.appendChild(fragment);
                requestAnimationFrame(() => {
                    this.#dom.messages.scrollTop = this.#dom.messages.scrollHeight;
                });
            }
        }

        #applyPendingQuestion() {
            if (!this.#pendingQuestion || !this.#dom.input) return;
            this.#dom.input.value = this.#pendingQuestion;
            this.#pendingQuestion = null;
        }

        // --- Message rendering ---

        #writeMessageContent(el, text, sender) {
            if (sender === "bot" && renderMarkdown) {
                const html = renderMarkdown(text);
                if (el.innerHTML !== html) el.innerHTML = html;
            } else if (el.textContent !== text) {
                el.textContent = text;
            }
        }

        #buildMessageEl(text, sender) {
            const div = document.createElement("div");
            const normalized = normalizeSender(sender);
            div.classList.add("chat-widget__message", `chat-widget__message--${normalized}`);
            div.setAttribute("role", normalized === "bot" ? "status" : "article");
            div.setAttribute("aria-live", normalized === "bot" ? "polite" : "off");
            if (normalized === "bot") div.dataset.rawText = text;
            this.#writeMessageContent(div, text, normalized);
            return div;
        }

        #addMessage(text, sender) {
            const { messages } = this.#dom;
            if (!messages) return null;
            
            const shouldScroll = isNearBottom(messages);
            const div = this.#buildMessageEl(text, sender);
            messages.appendChild(div);
            
            if (shouldScroll) {
                requestAnimationFrame(() => {
                    messages.scrollTop = messages.scrollHeight;
                });
            }
            return div;
        }

        #updateMessage(messageEl, text, forceScroll = false) {
            if (!messageEl) return;
            const sender = messageEl.classList.contains("chat-widget__message--user") ? "user" : "bot";
            
            messageEl.classList.toggle("chat-widget__message--loading", !text);
            this.#writeMessageContent(messageEl, text || "...", sender);
            
            const { messages } = this.#dom;
            if (messages && (forceScroll || isNearBottom(messages))) {
                requestAnimationFrame(() => {
                    messages.scrollTop = messages.scrollHeight;
                });
            }
        }

        #debouncedUpdateStorage = debounce((text) => {
            const history = this.#getHistory();
            if (history.length && history[history.length - 1].sender === "bot") {
                history[history.length - 1].text = text;
            } else {
                history.push({ text, sender: "bot" });
            }
            this.#safeStorage.set(STORAGE_KEY, history);
        }, 500);

        #setInputDisabled(disabled) {
            const { input, sendBtn } = this.#dom;
            if (input) input.disabled = disabled;
            if (sendBtn) {
                sendBtn.disabled = disabled;
                sendBtn.setAttribute("aria-busy", String(disabled));
            }
        }

        #cancelInflight() {
            this.#abortController?.abort();
            this.#abortController = null;
        }

        // --- Execute request & streaming ---

        async #handleSubmit(event) {
            event.preventDefault();
            const { input } = this.#dom;
            const text = input?.value?.trim() || "";
            if (!text) return;

            this.#addMessage(text, "user");
            this.#saveMessage({ text, sender: "user" });

            if (input) input.value = "";
            this.#setInputDisabled(true);

            this.#abortController = new AbortController();
            let botMessage = null;
            
            const throttler = createRafThrottler((nextText) => {
                this.#updateMessage(botMessage, nextText, true);
                this.#debouncedUpdateStorage(nextText);
            });

            try {
                botMessage = this.#addMessage("", "bot");
                const accumulated = await this.#streamChat(text, (next) => throttler.schedule(next), this.#abortController.signal);
                throttler.cancel();
                this.#updateMessage(botMessage, accumulated, true);
                this.#debouncedUpdateStorage(accumulated);
            } catch (error) {
                if (error.name === "AbortError") {
                    botMessage?.remove();
                } else {
                    if (botMessage && !botMessage.textContent) botMessage.remove();
                    const offline = !navigator.onLine || /offline/i.test(error.message ?? "");
                    const errorMsg = offline
                        ? "You appear to be offline. Please check your connection."
                        : "Sorry, I'm having trouble connecting. Please try again.";
                    this.#addMessage(errorMsg, "bot");
                }
            } finally {
                throttler.cancel();
                this.#abortController = null;
                this.#setInputDisabled(false);
                input?.focus({ preventScroll: true });
            }
        }

        async #streamChat(query, onUpdate, signal) {
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
