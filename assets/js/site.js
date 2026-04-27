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

    // Lazy-loaded markdown renderer for bot messages. Falls back to plain text on failure.
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
            async streamChat(query, onUpdate, signal) {
                if (!isOnline()) throw new Error("Offline");

                const response = await fetchImpl(endpoint, {
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
                } catch (error) {
                    reader.releaseLock();
                    throw error;
                } finally {
                    reader.releaseLock();
                }

                return accumulated;
            },
        };
    }

    // UI adapter for DOM writes.
    function createChatUi(elements, { body }) {
        const getMessages = () => elements.messages;
        const getInput = () => elements.input;
        const getSendBtn = () => elements.sendBtn;

        const writeMessageContent = (el, text, sender) => {
            if (sender === "bot" && renderMarkdown) {
                const html = renderMarkdown(text);
                if (el.innerHTML !== html) el.innerHTML = html;
            } else if (el.textContent !== text) {
                el.textContent = text;
            }
        };

        const buildMessageElement = (text, sender) => {
            const div = document.createElement("div");
            const normalizedSender = normalizeSender(sender);
            div.classList.add(
                "chat-widget__message",
                `chat-widget__message--${normalizedSender}`
            );
            div.setAttribute("role", normalizedSender === "bot" ? "status" : "article");
            div.setAttribute("aria-live", normalizedSender === "bot" ? "polite" : "off");
            writeMessageContent(div, text, normalizedSender);
            return div;
        };

        return {
            open() {
                elements.window?.classList.add("chat-widget__window--open");
                elements.widget?.classList.add("chat-widget--open");
                elements.window?.setAttribute("aria-hidden", "false");
                body?.classList.add("ai-chat-open");
            },
            close() {
                elements.window?.classList.remove("chat-widget__window--open");
                elements.widget?.classList.remove("chat-widget--open");
                elements.window?.setAttribute("aria-hidden", "true");
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
                const btn = getSendBtn();
                if (input) input.disabled = disabled;
                if (btn) btn.disabled = disabled;
            },
            setLoading(loading) {
                const btn = getSendBtn();
                if (btn) {
                    btn.disabled = loading;
                    btn.setAttribute("aria-busy", loading ? "true" : "false");
                }
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
                if (shouldScroll) {
                    requestAnimationFrame(() => {
                        messages.scrollTop = messages.scrollHeight;
                    });
                }
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
                requestAnimationFrame(() => {
                    messages.scrollTop = messages.scrollHeight;
                });
            },
            updateMessage(messageEl, text, forceScroll = false) {
                if (!messageEl) return;
                const sender = messageEl.classList.contains("chat-widget__message--user")
                    ? "user"
                    : "bot";

                // Toggle loading state
                if (!text) {
                    messageEl.classList.add("chat-widget__message--loading");
                } else {
                    messageEl.classList.remove("chat-widget__message--loading");
                }

                writeMessageContent(messageEl, text || "...", sender);
                const messages = getMessages();
                if (messages && (forceScroll || isNearBottom(messages))) {
                    requestAnimationFrame(() => {
                        messages.scrollTop = messages.scrollHeight;
                    });
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

    // Swipe gesture handler with enterprise patterns.
    class SwipeGestureHandler {
        constructor(config = {}) {
            this.config = {
                minDistance: config.minDistance ?? 100,
                minFastSwipeDistance: config.minFastSwipeDistance ?? 50,
                maxFastSwipeTime: config.maxFastSwipeTime ?? 300,
                direction: config.direction ?? 'down', // 'down', 'up', 'left', 'right'
            };

            this.state = {
                startX: 0,
                startY: 0,
                startTime: 0,
                isTracking: false,
            };

            this.handlers = new Map();
            this.onSwipe = config.onSwipe ?? (() => {});
            this.shouldStartTracking = config.shouldStartTracking ?? (() => true);
        }

        attach(element) {
            if (!element) return;

            const handleStart = this._handleStart.bind(this);
            const handleMove = this._handleMove.bind(this);
            const handleEnd = this._handleEnd.bind(this);
            const handleCancel = this._handleCancel.bind(this);

            element.addEventListener('touchstart', handleStart, { passive: false });
            element.addEventListener('touchmove', handleMove, { passive: false });
            element.addEventListener('touchend', handleEnd, { passive: true });
            element.addEventListener('touchcancel', handleCancel, { passive: true });

            this.handlers.set(element, {
                start: handleStart,
                move: handleMove,
                end: handleEnd,
                cancel: handleCancel,
            });
        }

        detach(element) {
            const handlers = this.handlers.get(element);
            if (!handlers || !element) return;

            element.removeEventListener('touchstart', handlers.start);
            element.removeEventListener('touchmove', handlers.move);
            element.removeEventListener('touchend', handlers.end);
            element.removeEventListener('touchcancel', handlers.cancel);

            this.handlers.delete(element);
        }

        detachAll() {
            for (const [element] of this.handlers) {
                this.detach(element);
            }
        }

        _handleStart(event) {
            if (!this.shouldStartTracking(event)) {
                this.state.isTracking = false;
                return;
            }

            const touch = event.touches[0];
            this.state = {
                startX: touch.clientX,
                startY: touch.clientY,
                startTime: Date.now(),
                isTracking: true,
            };
        }

        _handleMove(event) {
            if (!this.state.isTracking) return;

            const touch = event.touches[0];
            const deltaX = touch.clientX - this.state.startX;
            const deltaY = touch.clientY - this.state.startY;

            // Prevent default if moving in swipe direction
            if (this._isMovingInSwipeDirection(deltaX, deltaY)) {
                event.preventDefault();
            }
        }

        _handleEnd(event) {
            if (!this.state.isTracking) return;

            const touch = event.changedTouches[0];
            const deltaX = touch.clientX - this.state.startX;
            const deltaY = touch.clientY - this.state.startY;
            const deltaTime = Date.now() - this.state.startTime;

            if (this._isValidSwipe(deltaX, deltaY, deltaTime)) {
                this.onSwipe({ deltaX, deltaY, deltaTime });
            }

            this._resetState();
        }

        _handleCancel() {
            this._resetState();
        }

        _resetState() {
            this.state = {
                startX: 0,
                startY: 0,
                startTime: 0,
                isTracking: false,
            };
        }

        _isMovingInSwipeDirection(deltaX, deltaY) {
            const { direction } = this.config;
            if (direction === 'down') return deltaY > 0 && Math.abs(deltaY) > Math.abs(deltaX);
            if (direction === 'up') return deltaY < 0 && Math.abs(deltaY) > Math.abs(deltaX);
            if (direction === 'right') return deltaX > 0 && Math.abs(deltaX) > Math.abs(deltaY);
            if (direction === 'left') return deltaX < 0 && Math.abs(deltaX) > Math.abs(deltaY);
            return false;
        }

        _isValidSwipe(deltaX, deltaY, deltaTime) {
            const { direction, minDistance, minFastSwipeDistance, maxFastSwipeTime } = this.config;

            let distance = 0;
            if (direction === 'down') distance = deltaY;
            else if (direction === 'up') distance = -deltaY;
            else if (direction === 'right') distance = deltaX;
            else if (direction === 'left') distance = -deltaX;

            if (distance <= 0) return false;

            const isFastSwipe = distance >= minFastSwipeDistance && deltaTime <= maxFastSwipeTime;
            const isLongSwipe = distance >= minDistance;

            return isFastSwipe || isLongSwipe;
        }
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
            this.abortController = null;
            this.eventHandlers = new Map();
            this.swipeHandler = null;
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
                widget: $("#ai-chat-widget"),
                window: $("#ai-chat-window"),
                toggleBtn: $("#ai-chat-toggle"),
                closeBtn: $("#ai-chat-close"),
                clearBtn: $("#ai-chat-clear"),
                form: $("#ai-chat-form"),
                input: $("#ai-chat-input"),
                sendBtn: $("#ai-chat-send"),
                messages: $("#ai-chat-messages"),
            };
        }

        bindEvents() {
            const addHandler = (element, event, handler) => {
                if (!element) return;
                const boundHandler = handler.bind(this);
                element.addEventListener(event, boundHandler);
                this.eventHandlers.set(`${event}-${element.id}`, { element, event, handler: boundHandler });
            };

            addHandler(this.elements.toggleBtn, "click", () => this.open());
            addHandler(this.elements.closeBtn, "click", (event) => {
                event.stopPropagation();
                this.close();
            });
            addHandler(this.elements.clearBtn, "click", () => this.clearHistory());
            addHandler(this.elements.form, "submit", (event) => this.handleSubmit(event));

            // Keyboard shortcuts
            addHandler(this.elements.input, "keydown", (event) => {
                if (event.key === "Escape") {
                    this.close();
                } else if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    this.elements.form?.requestSubmit();
                }
            });

            // Swipe down to close gesture - enterprise pattern with dependency injection
            this.swipeHandler = new SwipeGestureHandler({
                direction: 'down',
                minDistance: 100,
                minFastSwipeDistance: 50,
                maxFastSwipeTime: 300,
                onSwipe: () => this.close(),
                shouldStartTracking: () => {
                    // Only track swipe if messages area is scrolled to top
                    const messages = this.elements.messages;
                    return messages ? messages.scrollTop === 0 : false;
                },
            });

            this.swipeHandler.attach(this.elements.window);
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
            this.cancelCurrentRequest();
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

        cancelCurrentRequest() {
            if (this.abortController) {
                this.abortController.abort();
                this.abortController = null;
            }
        }

        async handleSubmit(event) {
            event.preventDefault();
            const text = this.ui?.getInputValue().trim() ?? "";
            if (!text) return;

            this.addMessage(text, "user");
            this.saveMessage({ text, sender: "user" });

            this.ui?.setInputValue("");
            this.ui?.setInputDisabled(true);
            this.ui?.setLoading(true);

            this.abortController = new AbortController();
            let botMessage = null;
            const throttler = createRafThrottler((nextText) => {
                this.ui?.updateMessage(botMessage, nextText, true); // Force scroll during streaming
            });

            try {
                botMessage = this.addMessage("", "bot");
                const accumulated = await this.chatApi.streamChat(
                    text,
                    (nextText) => throttler.schedule(nextText),
                    this.abortController.signal
                );

                throttler.cancel();
                this.ui?.updateMessage(botMessage, accumulated, true); // Force scroll on final update

                if (accumulated) this.saveMessage({ text: accumulated, sender: "bot" });
            } catch (error) {
                if (error.name === "AbortError") {
                    this.logger.info("Request cancelled");
                    if (botMessage) botMessage.remove();
                } else {
                    this.logger.error(error);
                    if (botMessage && !botMessage.textContent) botMessage.remove();
                    const errorMsg = error.message.includes("Offline")
                        ? "You appear to be offline. Please check your connection."
                        : "Sorry, I'm having trouble connecting. Please try again.";
                    this.addMessage(errorMsg, "bot");
                }
            } finally {
                throttler.cancel();
                this.abortController = null;
                this.ui?.setInputDisabled(false);
                this.ui?.setLoading(false);
                this.ui?.focusInput();
            }
        }

        destroy() {
            this.cancelCurrentRequest();
            this.eventHandlers.forEach(({ element, event, handler }) => {
                element.removeEventListener(event, handler);
            });
            this.eventHandlers.clear();

            if (this.swipeHandler) {
                this.swipeHandler.detachAll();
                this.swipeHandler = null;
            }

            this.ui = null;
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
            loadMarkdown();
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
