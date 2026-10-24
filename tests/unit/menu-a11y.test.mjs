import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFeatureHost } from '../../assets/js/core/feature-host.js';
import { menuButtons, mobileMenuDismissal } from '../../assets/js/menu/features.js';

function fixture({ loading = false, missing = false } = {}) {
    const documentEvents = new Map();
    const element = (extra = {}) => ({
        listeners: new Map(),
        attributes: new Map(),
        addEventListener(name, handler) {
            this.listeners.set(name, handler);
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
    const buttons = [open, close, nested];
    for (const button of buttons) button.closest = () => button;
    const dialog = { contains: (target) => target === close || target === nested };
    const errors = [];
    const document = {
        readyState: loading ? 'loading' : 'complete',
        addEventListener: (name, handler) => documentEvents.set(name, handler),
        querySelectorAll: (selector) => (selector === 'button[data-menu-toggle]' ? buttons : []),
        getElementById: (id) => (missing ? undefined : { [toggle.id]: toggle, [submenu.id]: submenu, 'mobile-menu-dialog': dialog }[id]),
    };
    createFeatureHost({
        features: [menuButtons, mobileMenuDismissal],
        document,
        window: { Event },
        log: { error: (...args) => errors.push(args) },
    }).start();
    return { open, close, nested, toggle, submenu, documentEvents, errors };
}

test('Escape restores opener focus and outside clicks dismiss the menu', () => {
    const { open, close, toggle, documentEvents } = fixture();
    open.listeners.get('click')();
    documentEvents.get('click')({ target: close });
    assert.equal(toggle.checked, true);
    documentEvents.get('keydown')({ key: 'Escape' });
    assert.equal(toggle.checked, false);
    assert.equal(open.focused, true);
    open.listeners.get('click')();
    documentEvents.get('click')({ target: { closest: () => null } });
    assert.equal(toggle.checked, false);
    assert.equal(close.attributes.get('aria-expanded'), 'false');
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
    const { open, close, nested, toggle, submenu, documentEvents } = fixture();
    assert.equal(open.attributes.get('aria-expanded'), 'false');
    assert.equal(nested.attributes.get('aria-expanded'), 'true');
    open.listeners.get('click')();
    documentEvents.get('click')({ target: open });
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
