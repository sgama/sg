# AI Chat Widget Implementation

This document describes the current implementation, replacing an earlier design
summary that claimed Shadow DOM, configurable attributes, and touch gestures.
Those features are not implemented.

## Architecture

- [`assets/js/ai-chat-widget.js`](assets/js/ai-chat-widget.js) registers
  `<ai-chat-widget>` and owns the dialog, messages, storage, and request lifecycle.
- [`layouts/partials/extend-footer.html`](layouts/partials/extend-footer.html)
  supplies a light-DOM template and loads fingerprinted widget/site scripts.
- [`assets/css/site.css`](assets/css/site.css) provides the widget styles.
- [`assets/js/site.js`](assets/js/site.js) remains active: it handles external
  chat triggers, suggestion chips, and accessibility-panel integrations.

The widget uses light DOM, not Shadow DOM. Its settings are constants in the
script, not custom-element attributes. The dialog opens with `show()` (non-modal);
it does not provide modal focus trapping.

## Public Integration

The element exposes `open()`, `close()`, `toggle()`, and
`setPendingQuestion(text)`. It emits `chat-open` and `chat-close` events.
Links/buttons with `.js-chat-trigger` open it through the site script;
`data-question` supplies an optional pending question.

`connectedCallback()` clones the template and installs event handlers.
`disconnectedCallback()` cancels requests and removes registered listeners.
There is no `attributeChangedCallback()` or swipe-to-close implementation.

## Requests and Streaming

The widget posts `{ query }` to `/api/chat`. Browser history is persisted locally
but is not sent as model conversation history. The backend accepts bounded history
for clients that provide it.

The server normalizes provider streams into `data: {"response":"..."}` answer
events, optional usage events, and a `[DONE]` marker. Reasoning fields are omitted.
The widget parses answer events, throttles rendering with animation frames, and
displays an error for an explicit error event or a completed empty answer.

Closing the widget aborts its in-flight browser request. Markdown rendering uses
dynamically imported Marked and DOMPurify, falling back to text if loading fails.
These imports begin during widget initialization, not only after its first open.

## Storage and Accessibility

Chat history uses localStorage; open state uses sessionStorage. Storage access is
guarded to allow operation when browser storage is unavailable.

The template provides labeled controls, a textarea, and a native dialog.
Bot messages receive `role="status"` and `aria-live="polite"`. Keyboard handlers
support Enter to send, Shift+Enter for a newline, and Escape to close. The send
button exposes busy state while a request runs.

The messages container is a div, not an article with `role="log"`. Screen-reader
announcements, keyboard focus order, and mobile behavior still need browser testing;
this document does not claim they have passed an accessibility audit.

## Validation

```bash
make ai-test
make ai-build
```

The unit suite covers backend validation, provider-stream normalization, KV
logging, ingestion, evaluation, and release gates. It does not replace widget
browser tests.

Manual checks before a UI release:

- Open/close using buttons, external triggers, and Escape.
- Send with Enter and insert newlines with Shift+Enter.
- Check answer streaming, error messages, cancellation, and offline behavior.
- Confirm saved history and clear-history behavior.
- Check markdown sanitization and text fallback.
- Check keyboard focus, screen-reader announcements, and mobile layout.

See the [README](README.md#ai-infrastructure-and-model-evaluation) for model
selection, benchmark commands, and corpus release procedures.
