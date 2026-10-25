import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFeatureHost } from '../../assets/js/core/feature-host.js';
import { a11yBlur, a11yStars, chatTriggers, starfield, suggestionChips } from '../../assets/js/site/features.js';

function classList() {
    const classes = new Set();
    return {
        classes,
        add: (value) => classes.add(value),
        toggle: (value, enabled) => (enabled ? classes.add(value) : classes.delete(value)),
    };
}

function panelFixture(settings = { disableStars: true, disableBlur: true }) {
    const features = new Map();
    const updates = [];
    const stars = { addEventListener: (_, handler) => (stars.change = handler) };
    const blur = { addEventListener: (_, handler) => (blur.change = handler) };
    const documentElement = { classList: classList() };
    const document = {
        documentElement,
        querySelectorAll: (selector) => ({ '[id$="disable-stars"]': [stars], '[id$="disable-blur"]': [blur] })[selector] ?? [],
    };
    const window = {
        A11yPanel: {
            addFeature: (name, feature) => features.set(name, feature),
            getSettings: () => settings,
            updateSetting: (...args) => updates.push(args),
        },
    };
    return { context: { document, window }, classes: documentElement.classList.classes, features, updates, stars, blur };
}

test('a11y blur mirrors the panel setting and later changes', () => {
    const f = panelFixture();
    a11yBlur.init(f.context);
    assert.ok(f.classes.has('disable-blur'));
    f.blur.change({ target: { checked: false } });
    assert.ok(!f.classes.has('disable-blur'));
});

test('a11y stars registers the feature, initialises controls and propagates changes', () => {
    const f = panelFixture();
    a11yStars.init(f.context);
    assert.equal(f.stars.checked, true);
    assert.equal(f.features.get('disableStars').default, false);
    f.features.get('disableStars').apply(true);
    assert.ok(f.classes.has('disable-stars'));
    f.features.get('disableStars').apply(false);
    assert.ok(!f.classes.has('disable-stars'));
    f.stars.change({ target: { checked: false } });
    assert.deepEqual(f.updates, [['disableStars', false]]);
});

test('chat triggers ignore unrelated clicks and absent widgets and forward questions', () => {
    let click;
    let widget = null;
    const question = [];
    let opened = 0;
    chatTriggers.init({
        document: {
            addEventListener: (_, handler) => (click = handler),
            querySelector: () => widget,
        },
    });
    let prevented = 0;
    const event = (trigger) => ({ target: { closest: () => trigger }, preventDefault: () => prevented++ });
    click(event(null));
    click(event({ dataset: { question: 'Ignored' } }));
    widget = { setPendingQuestion: (value) => question.push(value), open: () => opened++ };
    click(event({ dataset: { question: 'Question' } }));
    assert.deepEqual(question, ['Question']);
    assert.equal(opened, 1);
    widget = {};
    click(event({ dataset: {} }));
    assert.equal(prevented, 2);
});

test('feature host runs ready features at once, idle features when scheduled, and isolates failures', () => {
    const ran = [];
    const failures = [];
    let idle;
    const site = createFeatureHost({
        document: { readyState: 'complete' },
        window: {},
        schedule: (task) => (idle = task),
        log: { error: (...args) => failures.push(args) },
        features: [
            { name: 'broken', init: () => assert.fail('boom') },
            { name: 'ready', init: (context) => ran.push(['ready', Object.keys(context)]) },
            { name: 'later', phase: 'idle', init: () => ran.push(['later']) },
        ],
    });
    site.start();
    assert.deepEqual(ran, [['ready', ['document', 'window', 'log']]]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0][0], 'Feature "broken" failed.');
    idle();
    assert.deepEqual(ran.at(-1), ['later']);
});

test('feature host waits for DOM readiness before starting features', () => {
    let ready;
    const ran = [];
    createFeatureHost({
        document: { readyState: 'loading', addEventListener: (_, handler) => (ready = handler) },
        window: {},
        schedule: () => {},
        features: [{ name: 'ready', init: () => ran.push('ready') }],
    }).start();
    assert.deepEqual(ran, []);
    ready();
    assert.deepEqual(ran, ['ready']);
});

test('starfield and suggestion chips run when idle and show a bounded set of chips', () => {
    const f = panelFixture();
    starfield.init(f.context);
    assert.ok(f.classes.has('stars-running'));
    const buttons = Array.from({ length: 7 }, () => ({}));
    suggestionChips.init({ document: { querySelectorAll: () => [{ querySelectorAll: () => buttons }, { querySelectorAll: () => [] }] } });
    assert.equal(buttons.filter((button) => !button.hidden).length, 4);
    assert.equal(buttons.filter((button) => button.hidden).length, 3);
    assert.deepEqual(
        [starfield, suggestionChips, a11yStars, a11yBlur].map((feature) => feature.phase),
        ['idle', 'idle', 'idle', 'idle'],
    );
});
