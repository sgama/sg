(() => {
    const STORAGE_KEY = "ai-chat-history";
    const OPEN_KEY = "ai-chat-open";
    const CONTAINER_ID = "ai-chat-widget";
    const API_ENDPOINT = "/api/chat";
    const WELCOME_MESSAGE =
        "Hello! I'm an AI assistant trained on this portfolio. Ask me anything about my projects or background.";

    // Shared utilities.
    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const runIdle = (fn) => {
        if ("requestIdleCallback" in window) {
            window.requestIdleCallback(fn, { timeout: 2000 });
            return;
        }
        setTimeout(fn, 250);
    };

    const normalizeSender = (sender) => (sender === "user" ? "user" : "bot");
    const isNearBottom = (el, threshold = 64) =>
        el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;

    function createSafeStore(store, { json = false } = {}) {
        return {
            get(key, fallback) {
                try {
                    const raw = store.getItem(key);
                    if (!json) return raw ?? fallback;
                    return raw ? JSON.parse(raw) : fallback;
                } catch {
                    // Ignore storage/parsing failures; fall back to default.
                    return fallback;
                }
            },
            set(key, value) {
                try {
                    const payload = json ? JSON.stringify(value) : value;
                    store.setItem(key, payload);
                } catch {
                    // Ignore storage failures (e.g., blocked, full, or private mode).
                }
            },
            remove(key) {
                try {
                    store.removeItem(key);
                } catch {
                    // Ignore storage failures (e.g., blocked, full, or private mode).
                }
            },
        };
    }

    const safeStorage = createSafeStore(localStorage, { json: true });
    const safeSession = createSafeStore(sessionStorage);

    // Generic helpers.
    function shuffleAndLimit(items, limit) {
        const list = items.slice();
        const count = Math.min(limit, list.length);
        for (let i = 0; i < count; i += 1) {
            const j = i + Math.floor(Math.random() * (list.length - i));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list.slice(0, count);
    }

    // Chat helpers (testable).
    function createChatHistoryManager(storage, storageKey, welcomeMessage) {
        const getHistory = () => storage.get(storageKey, []);

        const saveMessage = (msg) => {
            const history = getHistory();
            history.push(msg);
            storage.set(storageKey, history);
        };

        const ensureWelcomeMessage = () => {
            const history = getHistory();
            if (history.length) return history;
            const welcome = { text: welcomeMessage, sender: "bot" };
            saveMessage(welcome);
            return [welcome];
        };

        const clearHistory = () => storage.remove(storageKey);

        return {
            getHistory,
            saveMessage,
            ensureWelcomeMessage,
            clearHistory,
        };
    }

    function createSessionFlag(session, key) {
        return {
            isSet: () => session.get(key, "false") === "true",
            set: () => session.set(key, "true"),
            clear: () => session.remove(key),
        };
    }

    function createPendingQuestionStore(target = window) {
        return {
            get: () => target.pendingChatQuestion,
            set: (question) => {
                target.pendingChatQuestion = question;
            },
            clear: () => {
                delete target.pendingChatQuestion;
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
            } catch { }
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

    function createChatApiClient({ endpoint, fetchImpl = fetch, isOnline = () => navigator.onLine }) {
        return {
            async streamChat(query, onUpdate) {
                if (!isOnline()) throw new Error("Offline");

                const response = await fetchImpl(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ query }),
                });

                if (!response.ok || !response.body) {
                    throw new Error("Network response was not ok");
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let accumulated = "";
                const parser = createSseResponseParser((delta) => {
                    accumulated += delta;
                    onUpdate(accumulated, delta);
                });

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    parser.push(decoder.decode(value, { stream: true }));
                }

                parser.push(decoder.decode());
                parser.flush();

                return accumulated;
            },
        };
    }

    // UI adapter for DOM writes.
    function createChatUi(elements, { body }) {
        const getMessages = () => elements.messages;
        const getInput = () => elements.input;
        const buildMessageElement = (text, sender) => {
            const div = document.createElement("div");
            const normalizedSender = normalizeSender(sender);
            div.classList.add(
                "chat-widget__message",
                `chat-widget__message--${normalizedSender}`
            );
            div.textContent = text;
            return div;
        };

        return {
            open() {
                elements.window?.classList.add("chat-widget__window--open");
                body?.classList.add("ai-chat-open");
            },
            close() {
                elements.window?.classList.remove("chat-widget__window--open");
                body?.classList.remove("ai-chat-open");
            },
            focusInput() {
                getInput()?.focus();
            },
            getInputValue() {
                return getInput()?.value ?? "";
            },
            setInputValue(value) {
                const input = getInput();
                if (input) input.value = value;
            },
            setInputDisabled(disabled) {
                const input = getInput();
                if (input) input.disabled = disabled;
            },
            clearMessages() {
                const messages = getMessages();
                if (messages) messages.innerHTML = "";
            },
            addMessage(text, sender) {
                const messages = getMessages();
                if (!messages) return null;
                const shouldScroll = isNearBottom(messages);
                const div = buildMessageElement(text, sender);
                messages.appendChild(div);
                if (shouldScroll) messages.scrollTop = messages.scrollHeight;
                return div;
            },
            addMessages(items) {
                const messages = getMessages();
                if (!messages || !items.length) return;
                const fragment = document.createDocumentFragment();
                items.forEach((item) => {
                    fragment.appendChild(buildMessageElement(item.text, item.sender));
                });
                messages.appendChild(fragment);
                messages.scrollTop = messages.scrollHeight;
            },
            updateMessage(messageEl, text) {
                if (!messageEl) return;
                if (messageEl.textContent === text) return;
                messageEl.textContent = text;
                const messages = getMessages();
                if (messages && isNearBottom(messages)) {
                    messages.scrollTop = messages.scrollHeight;
                }
            },
        };
    }

    function createRafThrottler(update) {
        let scheduledFrame = null;
        let pendingText = "";

        return {
            schedule(nextText) {
                pendingText = nextText;
                if (scheduledFrame) return;
                scheduledFrame = window.requestAnimationFrame
                    ? window.requestAnimationFrame(() => {
                        scheduledFrame = null;
                        update(pendingText);
                    })
                    : setTimeout(() => {
                        scheduledFrame = null;
                        update(pendingText);
                    }, 16);
            },
            cancel() {
                if (!scheduledFrame) return;
                if (window.cancelAnimationFrame && window.requestAnimationFrame) {
                    window.cancelAnimationFrame(scheduledFrame);
                } else {
                    clearTimeout(scheduledFrame);
                }
                scheduledFrame = null;
            },
        };
    }

    // Chat widget.
    class AIChatWidget {
        constructor(options = {}) {
            const {
                storage = safeStorage,
                session = safeSession,
                confirmFn = window.confirm.bind(window),
                logger = console,
                historyManager,
                chatApi,
                pendingStore,
                apiEndpoint = API_ENDPOINT,
                containerId = CONTAINER_ID,
                storageKey = STORAGE_KEY,
            } = options;

            this.config = {
                containerId,
                apiEndpoint,
                storageKey,
            };
            this.elements = {};
            this.sessionFlag = createSessionFlag(session, OPEN_KEY);
            this.pendingStore = pendingStore ?? createPendingQuestionStore();
            this.history =
                historyManager ?? createChatHistoryManager(storage, storageKey, WELCOME_MESSAGE);
            this.chatApi = chatApi ?? createChatApiClient({ endpoint: apiEndpoint });
            this.confirm = confirmFn;
            this.logger = logger;
            this.ui = null;
            this.disabled = false;
            this.init();
        }

        init() {
            if (!this.render()) {
                this.disabled = true;
                return;
            }
            this.cacheElements();
            this.ui = createChatUi(this.elements, { body: document.body });
            this.bindEvents();
            this.loadHistory();
            this.applyPendingQuestion();
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
            this.ui?.open();
            this.ui?.focusInput();
            this.applyPendingQuestion();
            this.sessionFlag.set();
        }

        close() {
            this.ui?.close();
            this.sessionFlag.clear();
        }

        applyPendingQuestion() {
            const pending = this.pendingStore.get();
            if (pending) {
                this.ui?.setInputValue(pending);
                this.pendingStore.clear();
            }
        }

        renderHistory(history) {
            this.ui?.addMessages(
                history.map((msg) => ({
                    text: msg.text,
                    sender: msg.sender ?? "bot",
                }))
            );
        }

        loadHistory() {
            const history = this.history.ensureWelcomeMessage();
            this.renderHistory(history);
        }

        clearHistory() {
            if (!this.confirm("Delete chat history?")) return;
            this.history.clearHistory();
            this.ui?.clearMessages();
            const history = this.history.ensureWelcomeMessage();
            this.renderHistory(history);
        }

        addMessage(text, sender) {
            return this.ui?.addMessage(text, sender) ?? null;
        }

        saveMessage(msg) {
            this.history.saveMessage(msg);
        }

        async handleSubmit(event) {
            event.preventDefault();
            const text = this.ui?.getInputValue().trim() ?? "";
            if (!text) return;

            this.addMessage(text, "user");
            this.saveMessage({ text, sender: "user" });

            this.ui?.setInputValue("");
            this.ui?.setInputDisabled(true);

            let botMessage = null;
            const throttler = createRafThrottler((nextText) => {
                this.ui?.updateMessage(botMessage, nextText);
            });

            try {
                botMessage = this.addMessage("", "bot");
                const accumulated = await this.chatApi.streamChat(text, (nextText) => {
                    throttler.schedule(nextText);
                });

                throttler.cancel();
                this.ui?.updateMessage(botMessage, accumulated);

                if (accumulated) this.saveMessage({ text: accumulated, sender: "bot" });
            } catch (error) {
                this.logger.error(error);
                if (botMessage && !botMessage.textContent) botMessage.remove();
                this.addMessage("Sorry, I'm having trouble connecting. Please try again.", "bot");
            } finally {
                this.ui?.setInputDisabled(false);
                this.ui?.focusInput();
            }
        }
    }

    // Page-level helpers.
    function registerA11yStarsToggle() {
        if (!window.A11yPanel) return;
        window.A11yPanel.addFeature("disableStars", {
            default: false,
            apply: (enabled) => {
                document.documentElement.classList.toggle("disable-stars", enabled);
            },
        });

        const initial = !!window.A11yPanel.getSettings().disableStars;
        document.documentElement.classList.toggle("disable-stars", initial);

        $$('[id$="disable-stars"]').forEach((cb) => {
            cb.checked = initial;
            cb.onchange = (e) => window.A11yPanel.updateSetting("disableStars", e.target.checked);
        });
    }

    function mirrorDisableBlurClass() {
        if (!window.A11yPanel) return;
        const apply = (enabled) => document.documentElement.classList.toggle("disable-blur", enabled);
        apply(!!window.A11yPanel.getSettings().disableBlur);
        $$('[id$="disable-blur"]').forEach((cb) => {
            cb.addEventListener("change", (e) => apply(e.target.checked));
        });
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

    const openSession = createSessionFlag(safeSession, OPEN_KEY);
    const pendingQuestionStore = createPendingQuestionStore();

    function initChatOnce() {
        if (!window.aiChatInstance) {
            window.aiChatInstance = new AIChatWidget({ pendingStore: pendingQuestionStore });
        }
        return window.aiChatInstance.disabled ? null : window.aiChatInstance;
    }

    function wireChatTriggers() {
        document.addEventListener("click", (event) => {
            const trigger = event.target.closest(".js-chat-trigger");
            if (!trigger) return;

            event.preventDefault();
            const question = trigger.dataset.question;
            if (question) pendingQuestionStore.set(question);

            initChatOnce()?.open();
        });
    }

    function restoreChatState() {
        if (!openSession.isSet()) return;
        initChatOnce()?.open();
    }

    function boot() {
        wireChatTriggers();
        runIdle(() => {
            registerA11yStarsToggle();
            mirrorDisableBlurClass();
            applySuggestionChips();
            restoreChatState();
            document.documentElement.classList.add("stars-running");
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
        boot();
    }
})();
