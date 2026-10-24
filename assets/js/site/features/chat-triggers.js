/** Any `.js-chat-trigger` element opens the assistant, optionally prefilled from `data-question`. */
export const chatTriggers = {
    name: 'chat-triggers',
    init({ document }) {
        document.addEventListener('click', (event) => {
            const trigger = event.target.closest('.js-chat-trigger');
            if (!trigger) return;
            const widget = document.querySelector('ai-chat-widget');
            if (!widget) return;
            event.preventDefault();
            const question = trigger.dataset.question;
            if (question && typeof widget.setPendingQuestion === 'function') widget.setPendingQuestion(question);
            widget.open?.();
        });
    },
};
