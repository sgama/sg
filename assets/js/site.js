(() => {
    const STORAGE_KEY = "ai-chat-history";
    const OPEN_KEY = "ai-chat-open";
    const CONTAINER_ID = "ai-chat-widget";
    const API_ENDPOINT = "/api/chat";

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const runIdle = (fn) => {
        if ("requestIdleCallback" in window) {
            window.requestIdleCallback(fn, { timeout: 2000 });
            return;
        }
        setTimeout(fn, 250);
    };

    const safeStorage = {
        get(key, fallback) {
            try {
                const raw = localStorage.getItem(key);
                return raw ? JSON.parse(raw) : fallback;
            } catch {
                return fallback;
            }
        },
        set(key, value) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
            } catch { }
        },
        remove(key) {
            try {
                localStorage.removeItem(key);
            } catch { }
        },
    };

    const safeSession = {
        get(key, fallback) {
            try {
                return sessionStorage.getItem(key) ?? fallback;
            } catch {
                return fallback;
            }
        },
        set(key, value) {
            try {
                sessionStorage.setItem(key, value);
            } catch { }
        },
        remove(key) {
            try {
                sessionStorage.removeItem(key);
            } catch { }
        },
    };

    function shuffleAndLimit(items, limit) {
        const list = items.slice();
        const count = Math.min(limit, list.length);
        for (let i = 0; i < count; i += 1) {
            const j = i + Math.floor(Math.random() * (list.length - i));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list.slice(0, count);
    }

    class AIChatWidget {
        constructor() {
            this.config = {
                containerId: CONTAINER_ID,
                apiEndpoint: API_ENDPOINT,
                storageKey: STORAGE_KEY,
            };
            this.elements = {};
            this.disabled = false;
            this.init();
        }

        init() {
            if (!this.render()) {
                this.disabled = true;
                return;
            }
            this.cacheElements();
            this.bindEvents();
            this.loadHistory();
            this.applyPendingQuestion();
            window.openAiChat = () => this.open();
        }

        render() {
            const container = document.getElementById(this.config.containerId);
            if (!container) return false;
            if ($("#ai-chat-window", container)) return true;

            const template = document.getElementById("ai-chat-template");
            if (!template) return false;
            container.appendChild(template.content.cloneNode(true));
            return true;
        }

        cacheElements() {
            this.elements = {
                window: $("#ai-chat-window"),
                toggleBtn: $("#ai-chat-toggle"),
                closeBtn: $("#ai-chat-close"),
                clearBtn: $("#ai-chat-clear"),
                form: $("#ai-chat-form"),
                input: $("#ai-chat-input"),
                messages: $("#ai-chat-messages"),
            };
        }

        bindEvents() {
            this.elements.toggleBtn?.addEventListener("click", () => this.open());
            this.elements.closeBtn?.addEventListener("click", (event) => {
                event.stopPropagation();
                this.close();
            });
            this.elements.clearBtn?.addEventListener("click", () => this.clearHistory());
            this.elements.form?.addEventListener("submit", (event) => this.handleSubmit(event));
        }

        open() {
            this.elements.window?.classList.add("chat-widget__window--open");
            document.body.classList.add("ai-chat-open");
            this.elements.input?.focus();
            this.applyPendingQuestion();
            safeSession.set(OPEN_KEY, "true");
        }

        close() {
            this.elements.window?.classList.remove("chat-widget__window--open");
            document.body.classList.remove("ai-chat-open");
            safeSession.remove(OPEN_KEY);
        }

        applyPendingQuestion() {
            if (!this.elements.input) return;
            const pending = window.pendingChatQuestion;
            if (pending) {
                this.elements.input.value = pending;
                delete window.pendingChatQuestion;
            }
        }

        loadHistory() {
            const history = safeStorage.get(this.config.storageKey, []);
            if (history.length) {
                history.forEach((msg) => this.addMessage(msg.text, msg.sender));
                return;
            }
            this.addMessage(
                "Hello! I'm an AI assistant trained on this portfolio. Ask me anything about my projects or background.",
                "bot"
            );
        }

        clearHistory() {
            if (!confirm("Delete chat history?")) return;
            safeStorage.remove(this.config.storageKey);
            if (this.elements.messages) this.elements.messages.innerHTML = "";
            this.addMessage(
                "Hello! I'm an AI assistant trained on this portfolio. Ask me anything about my projects or background.",
                "bot"
            );
        }

        addMessage(text, sender) {
            if (!this.elements.messages) return null;
            const div = document.createElement("div");
            div.classList.add("chat-widget__message", `chat-widget__message--${sender}`);
            div.textContent = text;
            this.elements.messages.appendChild(div);
            this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
            return div;
        }

        saveMessage(msg) {
            const history = safeStorage.get(this.config.storageKey, []);
            history.push(msg);
            safeStorage.set(this.config.storageKey, history);
        }

        async handleSubmit(event) {
            event.preventDefault();
            const text = this.elements.input?.value.trim();
            if (!text) return;

            this.addMessage(text, "user");
            this.saveMessage({ text, sender: "user" });

            if (this.elements.input) {
                this.elements.input.value = "";
                this.elements.input.disabled = true;
            }

            let botMessage = null;
            let accumulated = "";

            try {
                if (!navigator.onLine) throw new Error("Offline");

                const response = await fetch(this.config.apiEndpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ query: text }),
                });

                if (!response.ok || !response.body) {
                    throw new Error("Network response was not ok");
                }

                botMessage = this.addMessage("", "bot");

                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split("\n");

                    for (const line of lines) {
                        if (!line.startsWith("data: ")) continue;
                        const dataStr = line.slice(6).trim();
                        if (dataStr === "[DONE]") continue;
                        try {
                            const json = JSON.parse(dataStr);
                            if (json.response) {
                                accumulated += json.response;
                                if (botMessage) {
                                    botMessage.textContent = accumulated;
                                    this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
                                }
                            }
                        } catch { }
                    }
                }

                if (accumulated) {
                    this.saveMessage({ text: accumulated, sender: "bot" });
                }
            } catch (error) {
                console.error(error);
                if (botMessage && !accumulated) botMessage.remove();
                this.addMessage("Sorry, I'm having trouble connecting. Please try again.", "bot");
            } finally {
                if (this.elements.input) {
                    this.elements.input.disabled = false;
                    this.elements.input.focus();
                }
            }
        }
    }

    function registerA11yStarsToggle() {
        if (!window.A11yPanel) return;
        window.A11yPanel.addFeature("disableStars", {
            default: false,
            apply: (enabled) => {
                if (enabled) {
                    document.documentElement.classList.add("disable-stars");
                } else {
                    document.documentElement.classList.remove("disable-stars");
                }
            },
        });

        const settings = window.A11yPanel.getSettings();
        if (settings.disableStars) {
            document.documentElement.classList.add("disable-stars");
        }
    }

    function applySuggestionChips() {
        $$(".chat-cta__chips").forEach((container) => {
            const buttons = $$(".chat-cta__chip", container);
            if (!buttons.length) return;
            const keep = new Set(shuffleAndLimit(buttons, 4));
            buttons.forEach((btn) => {
                btn.hidden = !keep.has(btn);
            });
        });
    }

    function initChatOnce() {
        if (!window.aiChatInstance) {
            window.aiChatInstance = new AIChatWidget();
            window.aiChatInitialized = !window.aiChatInstance.disabled;
        }
        return window.aiChatInstance.disabled ? null : window.aiChatInstance;
    }

    function wireChatTriggers() {
        document.addEventListener("click", (event) => {
            const trigger = event.target.closest(".js-chat-trigger");
            if (!trigger) return;

            event.preventDefault();
            const question = trigger.dataset.question;
            if (question) window.pendingChatQuestion = question;

            initChatOnce()?.open();
        });
    }

    function restoreChatState() {
        if (safeSession.get(OPEN_KEY, "false") !== "true") return;
        initChatOnce()?.open();
    }

    function boot() {
        wireChatTriggers();
        runIdle(() => {
            registerA11yStarsToggle();
            applySuggestionChips();
            restoreChatState();
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
        boot();
    }
})();
