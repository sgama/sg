(() => {
    // Shared utilities.
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const runIdle = (fn) => {
        if ("requestIdleCallback" in window) {
            window.requestIdleCallback(fn, { timeout: 2000 });
            return;
        }
        setTimeout(fn, 250);
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

    // ---- A11y panel integrations ----

    function registerA11yStarsToggle() {
        if (!window.A11yPanel) return;
        window.A11yPanel.addFeature("disableStars", {
            default: false,
            apply: (enabled) => {
                document.documentElement.classList.toggle("disable-stars", enabled);
            },
        });

        const initial = !!window.A11yPanel.getSettings().disableStars;
        $$('[id$="disable-stars"]').forEach((cb) => {
            cb.checked = initial;
            cb.onchange = (e) => window.A11yPanel.updateSetting("disableStars", e.target.checked);
        });
    }

    function mirrorDisableBlurClass() {
        if (!window.A11yPanel) return;
        const apply = (enabled) =>
            document.documentElement.classList.toggle("disable-blur", enabled);
        apply(!!window.A11yPanel.getSettings().disableBlur);
        $$('[id$="disable-blur"]').forEach((cb) => {
            cb.addEventListener("change", (e) => apply(e.target.checked));
        });
    }

    // ---- Homepage suggestion chips ----

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

    // ---- External chat triggers (delegate to <ai-chat-widget>) ----

    function getChatWidget() {
        return document.querySelector("ai-chat-widget");
    }

    function wireChatTriggers() {
        document.addEventListener("click", (event) => {
            const trigger = event.target.closest(".js-chat-trigger");
            if (!trigger) return;

            const widget = getChatWidget();
            if (!widget) return;

            event.preventDefault();
            const question = trigger.dataset.question;
            if (question && typeof widget.setPendingQuestion === "function") {
                widget.setPendingQuestion(question);
            }
            widget.open?.();
        });
    }

    // ---- Boot ----

    function boot() {
        wireChatTriggers();
        runIdle(() => {
            registerA11yStarsToggle();
            mirrorDisableBlurClass();
            applySuggestionChips();
            document.documentElement.classList.add("stars-running");
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
        boot();
    }
})();
