import { startWebApp, post } from './helpers/webApp.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { getGuildModule } from '../src/db/modules.js';

test('channel and role picker searches names and IDs, retains selections, rejects unknown additions and clears', () => {
  let factory;
  runInNewContext(readFileSync(new URL('../src/web/public/alpine-components.js', import.meta.url), 'utf8'), {
    document: { addEventListener: (_event, callback) => callback() },
    window: {
      Alpine: {
        data: (name, value) => {
          if (name === 'chipPicker') factory = value;
        },
      },
    },
  });
  const changes = [];
  const picker = factory({
    field: 'channels',
    kind: 'channel',
    items: [
      { id: CH.general, name: 'Ogólny' },
      { id: CH.bots, name: 'Boty' },
    ],
    selected: [CH.general, CH.general],
  });
  picker.$dispatch = (name) => changes.push(name);
  assert.deepEqual(Array.from(picker.selectedIds), [CH.general]);
  picker.query = ' BOT';
  assert.deepEqual(
    Array.from(picker.filtered, (item) => item.id),
    [CH.bots]
  );
  picker.query = CH.bots;
  assert.equal(picker.filtered.length, 1);
  picker.pick = 'unknown';
  picker.add();
  assert.equal(picker.selectedIds.length, 1);
  picker.pick = CH.bots;
  picker.add();
  assert.deepEqual(Array.from(picker.selectedIds), [CH.general, CH.bots]);
  assert.equal(picker.query, '');
  assert.equal(picker.available.length, 0);
  picker.remove(CH.general);
  picker.remove(CH.bots);
  assert.equal(picker.chips.length, 0);
  assert.equal(picker.available.length, 2);
  assert.ok(changes.every((name) => name === 'change'));
});

test('all former Ctrl-click fields render searchable pickers and persist multiple selections or an empty list', async () => {
  const app = await startWebApp();
  try {
    const cases = [
      ['auto-threads', 'channelIds', [CH.general, CH.bots], {}],
      ['afk', 'ignoreChannels', [CH.general, CH.bots], {}],
      ['autoresponder', 'ignoreChannels', [CH.general, CH.bots], {}],
      ['autoresponder', 'ignoreRoles', [ROLE.member, ROLE.admin], {}],
      ['tickets', 'staffRoles', [ROLE.member, ROLE.admin], {}],
      [
        'feedback',
        'subjectRoles',
        [ROLE.member, ROLE.admin],
        { panelChannel: CH.general, reviewChannel: CH.bots },
      ],
    ];
    for (const [module, field, ids, extra] of cases) {
      const body = new URLSearchParams(extra);
      for (const id of ids) body.append(field, id);
      const url = `/guilds/${GID}/m/${module}/config`;
      assert.equal((await post(app.base, url, body.toString())).status, 302, module);
      assert.deepEqual((await getGuildModule(GID, module)).config[field], ids, `${module}.${field}`);
      const page = await fetch(`${app.base}/guilds/${GID}/m/${module}`);
      assert.equal(page.status, 200, module);
      const html = await page.text();
      assert.doesNotMatch(html, /<select\b[^>]*\bmultiple\b/i, module);
      assert.match(html, /Szukaj po nazwie lub ID/, module);
      assert.match(html, new RegExp(`&#34;field&#34;:&#34;${field}&#34;`), module);
      assert.equal((await post(app.base, url, new URLSearchParams(extra).toString())).status, 302, module);
      assert.deepEqual((await getGuildModule(GID, module)).config[field], [], `${module}.${field} clear`);
    }
  } finally {
    app.close();
  }
});
