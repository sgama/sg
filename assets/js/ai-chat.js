class AIChatWidget {
    constructor(config = {}) {
        this.config = {
            containerId: 'ai-chat-widget',
            apiEndpoint: '/api/chat',
            storageKey: 'ai-chat-history',
            ...config
        };

        this.elements = {};
        this.init();
    }

    init() {
        this.render();
        this.cacheElements();
        this.loadHistory();
        this.bindEvents();

        // Global Exposure
        window.openAiChat = () => this.open();
    }

    render() {
        const container = document.getElementById(this.config.containerId);
        if (!container) return;

        container.insertAdjacentHTML('beforeend', `
            <div id="ai-chat-window">
                <div class="ai-chat-header">
                    <span>Assistant</span>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <button id="ai-chat-clear" aria-label="Clear History" title="Clear History" style="background:none;border:none;color:white;cursor:pointer;opacity:0.7;display:flex;">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                        </button>
                        <button id="ai-chat-close" aria-label="Close Chat" style="background:none;border:none;color:white;cursor:pointer;">&times;</button>
                    </div>
                </div>
                <div class="ai-chat-messages" id="ai-chat-messages"></div>
                <div class="ai-suggestions" id="ai-chat-suggestions" style="display: none;">
                    <button class="ai-suggestion-chip" data-question="What is Samson's experience with Python?">Python Experience?</button>
                    <button class="ai-suggestion-chip" data-question="Tell me about the EV Trip Analyzer project.">EV Trip Analyzer?</button>
                </div>
                <form class="ai-chat-input-area" id="ai-chat-form">
                    <input type="text" id="ai-chat-input" placeholder="Ask a question..." aria-label="Question" autocomplete="off">
                    <button type="submit" id="ai-chat-send">Send</button>
                </form>
            </div>
        `);
    }

    cacheElements() {
        this.elements = {
            window: document.getElementById('ai-chat-window'),
            toggleBtn: document.getElementById('ai-chat-toggle'),
            closeBtn: document.getElementById('ai-chat-close'),
            clearBtn: document.getElementById('ai-chat-clear'),
            form: document.getElementById('ai-chat-form'),
            input: document.getElementById('ai-chat-input'),
            messages: document.getElementById('ai-chat-messages'),
            suggestions: document.getElementById('ai-chat-suggestions')
        };
    }

    bindEvents() {
        if (this.elements.toggleBtn) {
            this.elements.toggleBtn.addEventListener('click', () => this.open());
        }

        document.querySelectorAll('.js-chat-trigger').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.open();
            });
        });

        this.elements.closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.close();
        });

        this.elements.clearBtn?.addEventListener('click', () => this.clearHistory());

        this.elements.suggestions?.querySelectorAll('.ai-suggestion-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                if (this.elements.input) {
                    this.elements.input.value = chip.dataset.question;
                    this.elements.form.dispatchEvent(new Event('submit'));
                }
                this.hideSuggestions();
            });
        });

        this.elements.form?.addEventListener('submit', (e) => this.handleSubmit(e));
    }

    open() {
        this.elements.window?.classList.add('open');
        document.body.classList.add('ai-chat-open');
        this.elements.input?.focus();
    }

    close() {
        this.elements.window?.classList.remove('open');
        document.body.classList.remove('ai-chat-open');
    }

    hideSuggestions() {
        if (this.elements.suggestions) {
            this.elements.suggestions.style.display = 'none';
        }
    }

    getHistory() {
        try {
            return JSON.parse(localStorage.getItem(this.config.storageKey) || '[]');
        } catch {
            return [];
        }
    }

    saveToHistory(msg) {
        try {
            const history = this.getHistory();
            history.push(msg);
            localStorage.setItem(this.config.storageKey, JSON.stringify(history));
        } catch (e) {
            console.error("Failed to save history:", e);
        }
    }

    loadHistory() {
        const history = this.getHistory();
        if (history.length > 0) {
            history.forEach(msg => this.addMessageToDOM(msg.text, msg.sender));
        } else {
            this.addWelcomeMessage();
        }
    }

    clearHistory() {
        if (confirm('Delete chat history?')) {
            localStorage.removeItem(this.config.storageKey);
            if (this.elements.messages) this.elements.messages.innerHTML = '';
            this.addWelcomeMessage();
        }
    }

    addWelcomeMessage() {
        this.addMessageToDOM("Hello! I'm an AI assistant trained on this portfolio. Ask me anything about my projects or background.", 'bot');
        if (this.elements.suggestions) {
            this.elements.suggestions.style.display = 'flex';
        }
    }

    addMessageToDOM(text, sender) {
        if (!this.elements.messages) return;
        const div = document.createElement('div');
        div.classList.add('ai-message', sender);
        div.textContent = text;
        this.elements.messages.appendChild(div);
        this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
        return div;
    }

    async handleSubmit(e) {
        e.preventDefault();
        const text = this.elements.input?.value.trim();
        if (!text) return;

        this.hideSuggestions();
        this.addMessageToDOM(text, 'user');
        this.saveToHistory({ text, sender: 'user' });

        if (this.elements.input) {
            this.elements.input.value = '';
            this.elements.input.disabled = true;
        }

        let botMessageDiv = null;
        let accumuledText = "";

        try {
            if (!navigator.onLine) throw new Error("Offline");

            const response = await fetch(this.config.apiEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: text })
            });

            if (!response.ok) throw new Error('Network response was not ok');

            botMessageDiv = this.addMessageToDOM("", 'bot');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.slice(6).trim();
                        if (dataStr === '[DONE]') continue;
                        try {
                            const json = JSON.parse(dataStr);
                            if (json.response) {
                                accumuledText += json.response;
                                if (botMessageDiv) {
                                    botMessageDiv.textContent = accumuledText;
                                    this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
                                }
                            }
                        } catch (e) { /* ignore partial json */ }
                    }
                }
            }

            if (accumuledText) {
                this.saveToHistory({ text: accumuledText, sender: 'bot' });
            }

        } catch (err) {
            console.error(err);
            if (botMessageDiv && !accumuledText) botMessageDiv.remove();
            this.addMessageToDOM("Sorry, I'm having trouble connecting. Please try again.", 'bot');
        } finally {
            if (this.elements.input) {
                this.elements.input.disabled = false;
                this.elements.input.focus();
            }
        }
    }
}

export function initChat(autoOpen = false) {
    const chat = new AIChatWidget();
    if (autoOpen) chat.open();
}
