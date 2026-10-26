import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFeatureHost } from '../../assets/js/core/feature-host.js';
import { menuButtons, mobileMenuDismissal } from '../../assets/js/menu/features.js';

function fixture({ loading = false, missing = false, dropdown = false } = {}) {
    const documentEvents = new Map();
    const element = (extra = {}) => ({
        listeners: new Map(),
        attributes: new Map(),
        addEventListener(name, handler) {
            const previous = this.listeners.get(name);
            this.listeners.set(name, previous ? (event) => (previous(event), handler(event)) : handler);
        },
        setAttribute(name, value) {
            this.attributes.set(name, value);
        },
        focus() {
            this.focused = true;
        },
        dispatchEvent(event) {
            this.listeners.get(event.type)?.(event);
        },
        ...extra,
    });
    const toggle = element({ id: 'mobile-menu-toggle', type: 'checkbox', checked: false });
    const submenu = element({ id: 'submenu', type: 'checkbox', checked: true });
    const open = element({ dataset: { menuToggle: toggle.id } });
    const close = element({ dataset: { menuToggle: toggle.id } });
    const nested = element({ dataset: { menuToggle: submenu.id } });
    const link = element();
    const buttons = [open, close, nested];
    for (const button of buttons) button.closest = () => button;
    const dialog = element({
        id: 'mobile-menu-dialog',
        open: false,
        modal: false,
        showModal() {
            this.open = true;
            this.modal = true;
        },
        close() {
            if (!this.open) return;
            this.open = false;
            this.modal = false;
            this.dispatchEvent({ type: 'close' });
        },
        getBoundingClientRect: () => ({ left: 100, right: 400, top: 100, bottom: 400 }),
        contains: (target) => [close, nested, link].includes(target),
        querySelector: () => link,
        classList: { contains: (name) => dropdown && name === 'mobile-menu-style-dropdown' },
        parentElement: { getBoundingClientRect: () => ({ left: 0, right: 500, top: 0, bottom: 50 }) },
        style: {},
    });
    const errors = [];
    const document = {
        readyState: loading ? 'loading' : 'complete',
        documentElement: { clientWidth: 1000 },
        addEventListener: (name, handler) => documentEvents.set(name, handler),
        querySelectorAll: (selector) => (selector === 'button[data-menu-toggle]' ? buttons : []),
        getElementById: (id) => (missing ? undefined : { [toggle.id]: toggle, [submenu.id]: submenu, 'mobile-menu-dialog': dialog }[id]),
    };
    createFeatureHost({
        features: [menuButtons, mobileMenuDismissal],
        document,
        window: { Event, scrollY: 0, getComputedStyle: () => ({ direction: 'ltr' }) },
        log: { error: (...args) => errors.push(args) },
    }).start();
    return { open, close, nested, link, toggle, submenu, dialog, documentEvents, errors };
}

test('backdrop clicks close the modal only outside its box', () => {
    const { open, close, toggle, dialog } = fixture();
    open.listeners.get('click')();
    dialog.dispatchEvent({ type: 'click', target: dialog, clientX: 150, clientY: 150 });
    assert.equal(dialog.open, true, 'clicks on the dialog padding stay open');
    dialog.dispatchEvent({ type: 'click', target: close, clientX: 0, clientY: 0 });
    assert.equal(dialog.open, true, 'clicks inside content stay open');
    dialog.dispatchEvent({ type: 'click', target: dialog, clientX: 20, clientY: 20 });
    assert.equal(dialog.open, false);
    assert.equal(toggle.checked, false);
    assert.equal(close.attributes.get('aria-expanded'), 'false');
});

test('dropdown mode anchors the top-layer dialog below its header row', () => {
    const { open, dialog } = fixture({ dropdown: true });
    open.listeners.get('click')();
    assert.equal(dialog.style.top, 'calc(50px + 0.75rem)');
    assert.equal(dialog.style.insetInlineEnd, '500px');
});

test('initializes after DOM readiness and reports missing toggle wiring', () => {
    const delayed = fixture({ loading: true });
    assert.equal(delayed.open.listeners.size, 0);
    delayed.documentEvents.get('DOMContentLoaded')();
    assert.equal(delayed.open.listeners.has('click'), true);
    const missing = fixture({ missing: true });
    assert.equal(missing.errors.length, 3);
    assert.equal(missing.errors[0][0], 'Menu toggle checkbox missing:');
});

test('native button clicks synchronize checkbox state and all expanded attributes', () => {
    const { open, close, nested, toggle, submenu } = fixture();
    assert.equal(open.attributes.get('aria-expanded'), 'false');
    assert.equal(nested.attributes.get('aria-expanded'), 'true');
    open.listeners.get('click')();
    assert.equal(toggle.checked, true);
    assert.equal(open.attributes.get('aria-expanded'), 'true');
    assert.equal(close.attributes.get('aria-expanded'), 'true');
    nested.listeners.get('click')();
    assert.equal(submenu.checked, false);
    assert.equal(nested.attributes.get('aria-expanded'), 'false');
    close.listeners.get('click')();
    assert.equal(toggle.checked, false);
    assert.equal(open.attributes.get('aria-expanded'), 'false');
    assert.equal(close.attributes.get('aria-expanded'), 'false');
    assert.equal(open.listeners.has('keydown'), false, 'Native buttons must not emulate Enter/Space and double-toggle');
});

test('opening shows a modal dialog and focuses its first link; native close restores opener focus', () => {
    const { open, close, link, toggle, dialog } = fixture();
    open.listeners.get('click')();
    assert.equal(dialog.open, true);
    assert.equal(dialog.modal, true, 'Must use showModal so the page behind is inert');
    assert.equal(link.focused, true);
    dialog.close();
    assert.equal(toggle.checked, false);
    assert.equal(close.attributes.get('aria-expanded'), 'false');
    assert.equal(open.focused, true);
});
