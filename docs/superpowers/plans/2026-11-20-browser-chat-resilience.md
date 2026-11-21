# Browser Chat Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a failed Mermaid diagram retry on the same evidence panel and make the required chat-widget roles an executable contract against real Hugo output.

**Architecture:** Keep `ai-chat-widget.js` as the browser composition root and retain the current chat model/view split. Add only a DOM-free canonical role list consumed by the controller and Hugo integration test; keep diagram retry state inside the existing renderer.

**Tech Stack:** Browser ES modules, Hugo-generated HTML, Node 24 native tests, existing Mermaid/DOMPurify dependencies, Make targets.

**Spec:** [2026-11-20 JavaScript Architecture and Reliability Design](../specs/2026-11-20-js-architecture-design.md)

## Global Constraints

- Do not impose MVC on other runtimes, add browser-service abstractions, or add dependencies.
- Keep the chat widget's public methods/events, markup role names, lazy Mermaid loading, SVG sanitization, and fallback text behavior stable.
- A failed Mermaid render must be retryable on the same code node; keep at most one fallback note and remove it after success.
- Validate roles in actual Hugo-rendered markup using the same DOM-free constant as the controller; do not maintain a second test-only role list.
- Use the existing test/build infrastructure; no deployment or paid operation is needed.

## Review Focus

- The Mermaid loader fails once and succeeds on the same node: the second panel open attempts rendering again (`tests/unit/chat-render.test.mjs`, Task 1).
- Repeated failures do not stack fallback notes, and later success removes the note (`tests/unit/chat-render.test.mjs`, Task 1).
- A missing, extra, or duplicate `data-role` in generated widget HTML fails the integration contract (`tests/integration/layouts.test.mjs`, Task 2).
- The role list can be imported in Node without browser globals (`tests/integration/layouts.test.mjs`, Task 2).
- Existing Hugo bundling, lazy chat libraries, and Mermaid chunks still work (`tests/integration/layouts.test.mjs`, Task 2).

---

### Task 1: Retry Mermaid rendering on the same source node

**Files:**

- Modify: `assets/js/chat/view/markdown-renderer.js`
- Test: `tests/unit/chat-render.test.mjs`

**Interfaces:**

- Preserve `createMessageRenderer(options)` and `renderDiagrams(element) -> Promise<void>`.
- Keep `memoizeUntilSuccess` behavior and existing safe SVG sanitization; add only per-node retry/fallback-note state.

- [ ] **Step 1: Add a failing test** named `a failed diagram render retries the same code node and replaces its fallback note`. Make the injected Mermaid loader fail once and then render successfully; call `renderDiagrams` twice on the same element and assert two attempts, successful replacement, and no remaining failure note. Also assert repeated failed attempts leave at most one note.
- [ ] **Step 2: Run the same-node test to verify it fails**

Run: `node --test --test-timeout=30000 --test-name-pattern='same code node' tests/unit/chat-render.test.mjs`
Expected: FAIL because the rendering `WeakSet` permanently filters out the code node after its first failure.

- [ ] **Step 3: Clear failed work and retain one removable note** in `markdown-renderer.js`. Remove the code node from the rendering set in the failure path, keep one fallback note associated with that node, and remove that note after successful rendering.
- [ ] **Step 4: Run chat rendering tests**

Run: `node --test --test-timeout=30000 tests/unit/chat-render.test.mjs`
Expected: PASS for lazy loading, SVG sanitization, readable failure fallback, same-node retry, and note cleanup.

- [ ] **Step 5: Commit the task**

```bash
git add assets/js/chat/view/markdown-renderer.js tests/unit/chat-render.test.mjs
git commit -m "fix: retry failed chat diagrams"
```

### Task 2: Test required widget roles against Hugo output

**Files:**

- Create: `assets/js/chat/widget-roles.js`
- Modify: `assets/js/ai-chat-widget.js`
- Test: `tests/integration/layouts.test.mjs`

**Interfaces:**

- Export `CHAT_WIDGET_ROLES` as a frozen array from `assets/js/chat/widget-roles.js` with the current names: `toggle`, `window`, `close`, `clear`, `form`, `input`, `send`, `stop`, `messages`, `transcript`, `latest`, `status`.
- Import the array in `ai-chat-widget.js` and use it in `hydrate()` instead of a private duplicated list. The roles module must not access `document`, `HTMLElement`, or other browser globals.

- [ ] **Step 1: Add the Hugo integration assertion** to the existing `default site emits typed JSON-LD, excludes internal context and preloads its actual WebP avatar` test. Import the intended shared role module and compare the sorted rendered `data-role` values from generated `index.html` with the sorted `CHAT_WIDGET_ROLES`; this also rejects duplicates and unexpected roles.
- [ ] **Step 2: Run the layout test to verify it fails for the missing shared role module**

Run: `make test-layouts`
Expected: FAIL during module resolution because `assets/js/chat/widget-roles.js` does not yet exist.

- [ ] **Step 3: Add the canonical role module and wire the controller to it**. Export a frozen array, import it from `ai-chat-widget.js`, and leave existing role names and hydration behavior unchanged.
- [ ] **Step 4: Run the layout test to verify the real markup contract**

Run: `make test-layouts`
Expected: PASS; Hugo emits each and only each required role once, and existing lazy-bundle/Mermaid checks still pass.

- [ ] **Step 5: Run browser typecheck and lint/format checks**

Run: `make typecheck lint format-check`
Expected: PASS; the role module remains DOM-free and the browser build is unchanged.

- [ ] **Step 6: Commit the task**

```bash
git add assets/js/chat/widget-roles.js assets/js/ai-chat-widget.js tests/integration/layouts.test.mjs
git commit -m "test: enforce chat widget template roles"
```

### Reconciled acceptance after Plans 1–3

After the shared-core, operational-script, and browser plans are complete, run once on the reconciled tree:

```bash
make lint
make format-check
make typecheck
make test
make test-layouts
make ai-build
make ci-check
```

Expected: all offline checks pass; do not run `make ci`, paid inference, deployment, or cloud mutations.
