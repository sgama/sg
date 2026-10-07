# AI Chat Widget Implementation

This document describes the current implementation, replacing an earlier design
summary that claimed Shadow DOM, configurable attributes, and touch gestures.
Those features are not implemented.

## Architecture

- [`assets/js/ai-chat-widget.js`](assets/js/ai-chat-widget.js) registers
  `<ai-chat-widget>` and coordinates the dialog, messages, and request lifecycle.
- [`assets/js/chat/`](assets/js/chat/) contains independent history, stream, and
  scroll controllers. Hugo bundles these local modules into one widget script.
- [`postcss.config.js`](postcss.config.js) preserves dynamically generated message
  classes when removing unused production CSS.
- [`layouts/partials/extend-footer.html`](layouts/partials/extend-footer.html)
  supplies a light-DOM template and loads fingerprinted widget/site scripts.
- [`assets/css/site.css`](assets/css/site.css) provides the widget styles.
- [`assets/js/site.js`](assets/js/site.js) remains active: it handles external
  chat triggers, suggestion chips, and accessibility-panel integrations.

The widget uses light DOM, not Shadow DOM. Its settings are constants in the
script, not custom-element attributes. The dialog opens with `show()` (non-modal);
it does not provide modal focus trapping.

## Appearance

Widget-scoped color tokens provide opaque white/slate surfaces in light mode
and charcoal/slate surfaces in dark mode. Blue accents are reserved for actions
and user bubbles; assistant messages use neutral surfaces. The widget follows
the site's `.dark` or root `data-theme="dark"` state without JavaScript.
The launcher has no continuous gradient animation, and controls use visible focus
outlines. These tokens do not change the rest of the site's accent palette.

## Public Integration

The element exposes `open()`, `close()`, `toggle()`, and
`setPendingQuestion(text)`. It emits `chat-open` and `chat-close` events.
Links/buttons with `.js-chat-trigger` open it through the site script;
`data-question` supplies an optional pending question.

`connectedCallback()` clones the template once and installs event handlers.
`disconnectedCallback()` cancels requests and removes registered listeners.
Reconnecting the same element reuses its DOM without duplicating messages or
handlers. There is no `attributeChangedCallback()` or swipe-to-close implementation.

## Scrolling and Focus

Opening always shows the latest message after the dialog has been laid out.
New questions reset follow mode; streamed answers keep the transcript at the
bottom while the reader is near it. Scrolling up pauses automatic following and
reveals a "Latest messages" button. Clicking it or returning to the bottom resumes
following. ResizeObserver handles delayed markdown/image layout and viewport
changes without polling. Message heights are measured normally, not estimated
with content-visibility placeholders.

The non-modal desktop dialog does not trap Tab focus. Escape works throughout
the dialog, and closing restores focus to the opener. Streaming does not move
focus. The composer remains editable during generation, with a Stop control;
duplicate submissions are blocked. Enter sends, Shift+Enter adds a newline, and
IME composition does not trigger submission.

## Requests and Streaming

The widget posts `{ query }` to `/api/chat`. Browser history is persisted locally
but is not sent as model conversation history. The backend accepts bounded history
for clients that provide it.

The server normalizes provider streams into `data: {"response":"..."}` answer
events, optional usage events, and a `[DONE]` marker. Reasoning fields are omitted.
The widget parses answer events, throttles rendering with animation frames, and
displays an error for an explicit error event, a completed empty answer, or a
stream that ends without its completion marker.

Closing, stopping, clearing history, or disconnecting aborts the in-flight browser
request. Partial answers are retained with a stopped/error notice. Request
identity guards prevent an older stream from modifying a newer conversation.
Completed/stopped messages are saved synchronously; there are no delayed storage
writes that can restore cleared history. Markdown rendering uses
dynamically imported Marked and DOMPurify, falling back to text if loading fails.
History reads, transcript rendering, resize observation, and Markdown imports
begin on first open, not during page initialization. An automatically restored
open session initializes immediately because its conversation is visible.
Closing and reopening reuse the initialized conversation; reconnecting resets
the lifecycle without duplicating the transcript.

## Storage and Accessibility

Chat history uses localStorage; open state uses sessionStorage. Storage access is
guarded to allow operation when browser storage is unavailable.

The template provides labeled controls, a textarea, and a native dialog.
The transcript has `role="log"` and polite live announcements, with
`aria-busy` during generation. A separate status region announces request state.
The textarea enforces the backend's 500-character limit. The toggle exposes
expanded state and references the dialog.

Screen-reader announcements and virtual-keyboard behavior still require testing
on actual assistive technologies and mobile devices; this is not an accessibility
audit certification.

## Validation

```bash
make ai-test
make ai-build
```

The unit suite covers the widget's storage validation, stream parsing/UTF-8,
completion/error handling, scroll following, resize handling, and cleanup, as well
as backend validation, ingestion, evaluation, and release gates. It does not
replace browser or assistive-technology tests.

Manual checks before a UI release:

- Open/close using buttons, external triggers, and Escape.
- Send with Enter and insert newlines with Shift+Enter.
- Check answer streaming, error messages, cancellation, and offline behavior.
- Confirm saved history and clear-history behavior.
- Check markdown sanitization and text fallback.
- Check keyboard focus, screen-reader announcements, and mobile layout.

See the [README](README.md#ai-infrastructure-and-model-evaluation) for model
selection, benchmark commands, and corpus release procedures.
