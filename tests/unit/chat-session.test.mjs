import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureMessage, stageLabel } from '../../assets/js/chat/session.js';

test('stage labels cover every progress stage the server streams', () => {
    for (const stage of ['rewrite', 'embedding', 'search', 'generation']) {
        assert.equal(typeof stageLabel(stage), 'string');
    }
    assert.equal(stageLabel('unknown'), undefined);
});

test('failure messages distinguish offline from a server-side failure', () => {
    assert.match(failureMessage(false), /offline/);
    assert.match(failureMessage(true), /could not be completed/);
});
