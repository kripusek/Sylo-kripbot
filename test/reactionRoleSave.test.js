import { startWebApp, post } from './helpers/webApp.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function form(style, pairs, extra = {}) {
  const body = new URLSearchParams({ channelId: CH.general, rr_style: style, message: 'Role', ...extra });
  for (const pair of pairs) {
    body.append('rr_role', pair.roleId || '');
    body.append('rr_emoji', pair.emoji || '');
    body.append('rr_label', pair.label || '');
    body.append('rr_btnstyle', 'secondary');
  }
  return body.toString();
}

test('buttons and select save role IDs without emojis and edit without losing selected roles', async () => {
  const app = await startWebApp();
  try {
    await setGuildModule(GID, 'roles', { config: {} });
    for (const style of ['buttons', 'select']) {
      const id = style === 'buttons' ? '101' : '102';
      const result = await post(
        app.base,
        `/guilds/${GID}/m/roles/rr`,
        form(style, [{ roleId: ROLE.member }, { roleId: ROLE.admin, label: 'Admins' }], { id })
      );
      assert.equal(result.status, 302);
      const config = (await getGuildModule(GID, 'roles')).config;
      const saved = config.reactionMessages.find((x) => x.id === id);
      assert.deepEqual(
        saved.pairs.map((p) => p.roleId),
        [ROLE.member, ROLE.admin]
      );
      const html = await (await fetch(`${app.base}/guilds/${GID}/m/roles/rr/${id}`)).text();
      assert.match(html, new RegExp(`<option value="${ROLE.member}">Member</option>`));
      assert.match(html, /:key="row.key"/);
      assert.doesNotMatch(html, /<template x-for="r in roles"/);
      assert.match(html, new RegExp(`&#34;roleId&#34;:&#34;${ROLE.member}&#34;`));
      assert.equal(
        (
          await post(
            app.base,
            `/guilds/${GID}/m/roles/rr`,
            form(
              style,
              saved.pairs.map((p) => ({ ...p, emoji: p.display })),
              { id }
            )
          )
        ).status,
        302
      );
      assert.deepEqual(
        (await getGuildModule(GID, 'roles')).config.reactionMessages
          .find((x) => x.id === id)
          .pairs.map((p) => p.roleId),
        [ROLE.member, ROLE.admin]
      );
    }
  } finally {
    app.close();
  }
});

test('invalid reaction row reports its index, preserves submitted data and leaves old config untouched', async () => {
  const app = await startWebApp();
  try {
    const original = {
      reactionMessages: [
        {
          id: '201',
          channelId: CH.general,
          style: 'reaction',
          pairs: [{ roleId: ROLE.member, display: '✅', key: '✅', react: '✅' }],
        },
      ],
    };
    await setGuildModule(GID, 'roles', { config: original });
    const result = await post(
      app.base,
      `/guilds/${GID}/m/roles/rr`,
      form(
        'reaction',
        [
          { roleId: ROLE.member, emoji: '✅' },
          { roleId: ROLE.admin, label: 'Keep this label' },
        ],
        {
          id: '201',
          message: 'Keep this message',
          embed: JSON.stringify({ title: 'Keep title', description: 'Keep description' }),
        }
      )
    );
    assert.equal(result.status, 400);
    const html = await result.text();
    assert.match(html, /Wiersz 2: wybierz poprawną emotkę/);
    assert.match(html, /Keep this message/);
    assert.match(html, /Keep this label/);
    assert.match(html, /Keep title/);
    assert.match(html, new RegExp(`&#34;roleId&#34;:&#34;${ROLE.admin}&#34;`));
    assert.deepEqual((await getGuildModule(GID, 'roles')).config, original);
    assert.equal(app.sink.messages.length, 0);
  } finally {
    app.close();
  }
});

test('missing role and duplicate select options are rejected without silently dropping rows', async () => {
  const app = await startWebApp();
  try {
    await setGuildModule(GID, 'roles', { config: {} });
    for (const [style, pairs, pattern] of [
      ['buttons', [{ roleId: ROLE.member }, { label: 'No role' }], /Wiersz 2: wybierz rolę/],
      ['select', [{ roleId: ROLE.member }, { roleId: ROLE.member }], /Wiersz 2: ta rola jest już wybrana/],
      [
        'reaction',
        [
          { roleId: ROLE.member, emoji: '✅' },
          { roleId: ROLE.admin, emoji: '✅' },
        ],
        /Wiersz 2: ta emotka jest już użyta/,
      ],
    ]) {
      const result = await post(app.base, `/guilds/${GID}/m/roles/rr`, form(style, pairs));
      assert.equal(result.status, 400);
      assert.match(await result.text(), pattern);
      assert.deepEqual((await getGuildModule(GID, 'roles')).config, {});
    }
  } finally {
    app.close();
  }
});

test('removing a middle role row retains other selections and stable unique keys', () => {
  let factory;
  runInNewContext(readFileSync(new URL('../src/web/public/alpine-components.js', import.meta.url), 'utf8'), {
    document: { addEventListener: (_event, callback) => callback() },
    window: {
      syloT: (s) => s,
      Alpine: {
        data: (name, value) => {
          if (name === 'rrRows') factory = value;
        },
      },
    },
  });
  const picker = factory({
    style: 'buttons',
    pairs: [{ roleId: ROLE.member }, { roleId: ROLE.admin }, { roleId: 'third' }],
  });
  const last = picker.rows[2];
  picker.removeRow(1);
  assert.equal(picker.rows[1], last);
  picker.addRow();
  assert.equal(new Set(picker.rows.map((r) => r.key)).size, 3);
  assert.equal(picker.rows[0].roleId, ROLE.member);
  assert.equal(picker.rows[1].roleId, 'third');
});
