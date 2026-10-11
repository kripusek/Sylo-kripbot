import { startWebApp, post } from './helpers/webApp.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { getGuildModule } from '../src/db/modules.js';

function body(count, emptyIndex = -1) {
  const values = new URLSearchParams();
  for (let i = 0; i < count; i++) {
    for (const [field, value] of Object.entries({
      ar_trigger: `słowo${i}`,
      ar_response: i === emptyIndex ? '' : `Odpowiedź ${i}`,
      ar_match: 'exact',
      ar_response_type: 'text',
      ar_images: '',
      ar_embed: 'text',
      ar_delete: 'keep',
    }))
      values.append(field, value);
  }
  return values.toString();
}

test('delegated Add responder keeps working after the entire form is replaced by HTMX', () => {
  const clicks = [];
  runInNewContext(readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8'), {
    document: {
      querySelector: () => null,
      addEventListener: (name, fn) => {
        if (name === 'click') clicks.push(fn);
      },
    },
    window: {},
  });
  function form() {
    const rows = { children: [{}, {}, {}], appendChild: (fragment) => rows.children.push(fragment) };
    let focused = 0;
    const template = {
      content: { cloneNode: () => ({ querySelector: () => ({ focus: () => focused++ }) }) },
    };
    const f = { querySelector: (selector) => (selector === '#ar-rows' ? rows : template) };
    return { rows, focused: () => focused, button: { closest: () => f } };
  }
  const before = form();
  const after = form();
  function click(button) {
    const event = { target: { closest: (selector) => (selector === '[data-ar-add]' ? button : null) } };
    for (const handler of clicks) handler(event);
  }
  click(before.button);
  assert.equal(before.rows.children.length, 4);
  click(after.button); // Simulate the new button after Save without executing inline scripts.
  click(after.button);
  assert.equal(after.rows.children.length, 5);
  assert.equal(before.rows.children.length, 4);
  assert.equal(after.focused(), 2);
});

test('V1 persists five responders across HTMX saves and rejects an incomplete fourth without data loss', async () => {
  const app = await startWebApp();
  try {
    const path = `/guilds/${GID}/m/autoresponder/config`;
    const saved = await post(app.base, path, body(5), { 'HX-Request': 'true' });
    assert.equal(saved.status, 200);
    const html = await saved.text();
    assert.match(html, /data-ar-add/);
    assert.match(html, /data-ar-template/);
    assert.doesNotMatch(html, /getElementById\('ar-add'\)/);
    assert.equal((await getGuildModule(GID, 'autoresponder')).config.responders.length, 5);
    const page = await (await fetch(`${app.base}/guilds/${GID}/m/autoresponder`)).text();
    assert.match(page, /value="słowo4"/);
    const invalid = await post(app.base, path, body(5, 3), { 'HX-Request': 'true' });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /Odpowiedź 4: wpisz treść/);
    assert.ok(invalid.headers.get('hx-trigger').includes('toast'));
    assert.equal((await getGuildModule(GID, 'autoresponder')).config.responders.length, 5);
  } finally {
    app.close();
  }
});
