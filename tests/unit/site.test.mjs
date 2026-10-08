import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const url = new URL('../../assets/js/site.js', import.meta.url);
const source = await readFile(url, 'utf8');

function fixture({ loading = false, idle = true, accessibility = true } = {}) {
    const listeners = new Map();
    const classes = new Set();
    const features = new Map();
    const updates = [];
    const stars = {};
    const blur = {
        addEventListener: (_, handler) => {
            blur.change = handler;
        },
    };
    const buttons = Array.from({ length: 7 }, () => ({}));
    const chips = { querySelectorAll: () => buttons };
    const question = [];
    let opened = 0;
    let widget = { setPendingQuestion: (value) => question.push(value), open: () => opened++ };
    let deferred;
    const document = {
        readyState: loading ? 'loading' : 'complete',
        documentElement: {
            classList: {
                add: (value) => classes.add(value),
                toggle: (value, enabled) => (enabled ? classes.add(value) : classes.delete(value)),
            },
        },
        addEventListener: (event, handler) => listeners.set(event, handler),
        querySelector: () => widget,
        querySelectorAll: (selector) =>
            ({
                '[id$="disable-stars"]': [stars],
                '[id$="disable-blur"]': [blur],
                '.chat-cta__chips': [chips, { querySelectorAll: () => [] }],
            })[selector] ?? [],
    };
    const window = {
        ...(idle
            ? {
                  requestIdleCallback: (fn, options) => {
                      assert.equal(options.timeout, 2000);
                      deferred = fn;
                  },
              }
            : {}),
        ...(accessibility
            ? {
                  A11yPanel: {
                      addFeature: (name, feature) => features.set(name, feature),
                      getSettings: () => ({ disableStars: true, disableBlur: true }),
                      updateSetting: (...args) => updates.push(args),
                  },
              }
            : {}),
    };
    runInNewContext(
        source,
        {
            document,
            window,
            setTimeout: (fn, ms) => {
                assert.equal(ms, 250);
                deferred = fn;
            },
        },
        { filename: fileURLToPath(url) },
    );
    return {
        listeners,
        classes,
        features,
        updates,
        stars,
        blur,
        buttons,
        question,
        boot: () => listeners.get('DOMContentLoaded')(),
        idle: () => deferred(),
        setWidget: (value) => {
            widget = value;
        },
        opened: () => opened,
    };
}

test('accessibility settings initialize controls and propagate changes', () => {
    const f = fixture();
    f.idle();
    assert.equal(f.stars.checked, true);
    assert.equal(f.features.get('disableStars').default, false);
    f.features.get('disableStars').apply(true);
    assert.ok(f.classes.has('disable-stars'));
    f.features.get('disableStars').apply(false);
    assert.ok(!f.classes.has('disable-stars'));
    f.stars.onchange({ target: { checked: false } });
    assert.deepEqual(f.updates, [['disableStars', false]]);
    assert.ok(f.classes.has('disable-blur'));
    f.blur.change({ target: { checked: false } });
    assert.ok(!f.classes.has('disable-blur'));
});

test('chat triggers ignore unrelated clicks and absent widgets and forward questions', () => {
    const f = fixture();
    const click = f.listeners.get('click');
    let prevented = 0;
    const event = (trigger) => ({
        target: { closest: () => trigger },
        preventDefault: () => prevented++,
    });
    click(event(null));
    click(event({ dataset: { question: 'Question' } }));
    assert.deepEqual(f.question, ['Question']);
    assert.equal(f.opened(), 1);
    f.setWidget({});
    click(event({ dataset: {} }));
    f.setWidget(null);
    click(event({ dataset: { question: 'Ignored' } }));
    assert.equal(prevented, 2);
});

test('idle fallback boots after DOM readiness without accessibility integration', () => {
    const f = fixture({ loading: true, idle: false, accessibility: false });
    assert.ok(!f.listeners.has('click'));
    f.boot();
    f.idle();
    assert.ok(f.classes.has('stars-running'));
    assert.equal(f.buttons.filter((button) => !button.hidden).length, 4);
    assert.equal(f.buttons.filter((button) => button.hidden).length, 3);
});
