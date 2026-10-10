import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHeaderValue } from 'node:http';
import { headerJson } from '../src/web/lib/httpJson.js';

test('HTMX headers preserve Polish channel names, emoji and failure messages', () => {
  for (const msg of [
    'Test sent to #ogłoszenia-📢',
    'Send failed — check the bot has access to that channel.',
    'Zażółć gęślą jaźń',
  ]) {
    const payload = { toast: { msg, kind: 'ok' } };
    const encoded = headerJson(payload);
    assert.doesNotThrow(() => validateHeaderValue('HX-Trigger', encoded));
    assert.deepEqual(JSON.parse(encoded), payload);
  }
});
