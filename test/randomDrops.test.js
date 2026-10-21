import { startWebApp } from './helpers/webApp.js';
import { GID, CH } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseDrop, pickRandom, handleDropClick } from '../src/modules/randomDrops.js';
import { saveDrop, claimDrop, getDrop, deleteDrop, listDrops } from '../src/db/randomDrops.js';

const GUILD = '800000000000000009';
const U1 = '700000000000000011';
const U2 = '700000000000000012';

test('normaliseDrop cleans fields and splits the pool by line', () => {
  const d = normaliseDrop({
    name: '  ',
    channelId: 'x',
    text: '',
    buttonLabel: '',
    pool: ' kot \r\n\n pies \n',
  });
  assert.deepEqual(d.pool, ['kot', 'pies']);
  assert.equal(d.channelId, '');
  assert.equal(d.name, 'Losowa wiadomość');
  assert.equal(normaliseDrop({ pool: Array.from({ length: 300 }, (_, i) => `l${i}`) }).pool.length, 200);
  assert.equal(
    pickRandom(['a', 'b', 'c'], () => 0.99),
    'c'
  );
  assert.equal(
    pickRandom(['a', 'b', 'c'], () => 0),
    'a'
  );
});

test('claimDrop succeeds once per member, even when raced', async () => {
  const id = await saveDrop(GUILD, null, normaliseDrop({ pool: ['x'] }));
  const results = await Promise.all([1, 2, 3].map(() => claimDrop(id, U1, GUILD, 'x')));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await claimDrop(id, U2, GUILD, 'x'), true);
  assert.equal((await listDrops(GUILD))[0].claims, 2);
  assert.equal(await deleteDrop(GUILD, id), true);
  assert.equal(await getDrop(id), null);
});

const click = (id, userId, { guildId = GUILD, failDm = false } = {}) => {
  const out = { replies: [], dms: [] };
  return {
    out,
    interaction: {
      customId: `rdrop:${id}`,
      guildId,
      user: {
        id: userId,
        send: async (p) => {
          if (failDm) throw new Error('blocked');
          out.dms.push(p);
        },
      },
      reply: async (p) => out.replies.push(p),
    },
  };
};

test('button click DMs a random line once and refuses a second click', async () => {
  const id = await saveDrop(GUILD, null, normaliseDrop({ pool: ['jedyne'] }));
  const first = click(id, U1);
  await handleDropClick(first.interaction);
  assert.equal(first.out.dms[0].content, 'jedyne');
  assert.match(first.out.replies[0].content, /DM/);

  const again = click(id, U1);
  await handleDropClick(again.interaction);
  assert.equal(again.out.dms.length, 0);
  assert.match(again.out.replies[0].content, /tylko raz/);

  const blocked = click(id, U2, { failDm: true });
  await handleDropClick(blocked.interaction);
  assert.match(blocked.out.replies[0].content, /jedyne/); // falls back to the ephemeral reply

  const other = click(id, '700000000000000013', { guildId: '1' });
  await handleDropClick(other.interaction);
  assert.match(other.out.replies[0].content, /nie jest już aktywna/);
  assert.equal(other.out.dms.length, 0);
});

test('dashboard saves, publishes and deletes a drop', async () => {
  const app = await startWebApp();
  try {
    const call = (path, body) =>
      fetch(`${app.base}/guilds/${GID}/drops${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });

    const empty = await call('/save', { name: 'T', channelId: CH.general, pool: 'a\nb', text: 'Hej' });
    assert.equal(empty.status, 200);
    const { drop } = await empty.json();
    assert.deepEqual(drop.pool, ['a', 'b']);

    const noChannel = await call('/save', { name: 'Brak', pool: 'x' });
    const bad = (await noChannel.json()).drop;
    assert.equal((await call(`/${bad.id}/publish`, {})).status, 400);

    const published = await call(`/${drop.id}/publish`, {});
    assert.equal(published.status, 200);
    assert.equal((await published.json()).status, 'sent');
    const sent = app.sink.messages.at(-1);
    assert.equal(sent.channel, CH.general);
    assert.equal(sent.payload.embeds[0].description, 'Hej');
    assert.equal(sent.payload.components[0].components[0].data.custom_id, `rdrop:${drop.id}`);

    const list = (await (await call('/list')).json()).drops;
    assert.equal(list.find((d) => d.id === drop.id).published, true);

    assert.equal((await call(`/${drop.id}/delete`, {})).status, 200);
    assert.equal((await call(`/${drop.id}/delete`, {})).status, 404);
    assert.equal((await call('/save', { id: 999999, pool: 'x' })).status, 404);
  } finally {
    app.close();
  }
});

test('VS mode rolls two different entries plus a random category', async () => {
  const { rollResult } = await import('../src/modules/randomDrops.js');
  const drop = { vs_mode: true, pool: ['kot', 'pies', 'ryba'], categories: ['kto lepszy?', 'kto wygra?'] };
  assert.equal(
    rollResult(drop, () => 0),
    '**kot** vs **pies**\n*kto lepszy?*'
  );
  assert.equal(
    rollResult(drop, () => 0.99),
    '**ryba** vs **pies**\n*kto wygra?*'
  );
  for (let i = 0; i < 200; i++) {
    const [, a, b] = /^\*\*(.+)\*\* vs \*\*(.+)\*\*/.exec(rollResult(drop)) ?? [];
    assert.ok(a && b && a !== b);
  }
  assert.equal(
    rollResult({ ...drop, categories: [] }, () => 0),
    '**kot** vs **pies**'
  );
  assert.equal(rollResult({ vs_mode: false, pool: ['x'], categories: [] }), 'x');
});

test('VS mode is saved, needs two entries to publish, and DMs the pair on click', async () => {
  const d = normaliseDrop({ vsMode: 'on', pool: 'a\nb', categories: 'kto lepszy?' });
  assert.equal(d.vsMode, true);
  assert.deepEqual(d.categories, ['kto lepszy?']);
  assert.equal(normaliseDrop({}).vsMode, false);

  const id = await saveDrop(GUILD, null, normaliseDrop({ vsMode: true, pool: 'solo' }));
  assert.equal((await getDrop(id)).vs_mode, true);
  const tooShort = click(id, U1);
  await handleDropClick(tooShort.interaction);
  assert.match(tooShort.out.replies[0].content, /za krótka/);
  assert.equal(tooShort.out.dms.length, 0);

  const ok = await saveDrop(GUILD, null, d);
  const hit = click(ok, U1);
  await handleDropClick(hit.interaction);
  assert.match(hit.out.dms[0].content, /^\*\*[ab]\*\* vs \*\*[ab]\*\*\n\*kto lepszy\?\*$/);
});

test('Embed messages: a random row becomes a button, and a click uses the saved list', async () => {
  const { buildPayload } = await import('../src/modules/messageCreator.js');
  const { createComposed } = await import('../src/db/composedMessages.js');
  const { handleComposedDropClick } = await import('../src/modules/randomDrops.js');

  const row = {
    type: 'random',
    label: 'Losuj!',
    vsMode: true,
    pool: ['a', 'b'],
    categories: ['kto lepszy?'],
  };
  const { payload } = buildPayload({ content: 'x', embeds: [], rows: [row] });
  assert.equal(payload.components[0].components[0].data.custom_id, 'rdrop:msg');
  assert.equal(payload.components[0].components[0].data.label, 'Losuj!');
  assert.throws(() => buildPayload({ content: 'x', rows: [{ ...row, pool: ['solo'] }] }), /dwie linie/);
  assert.throws(
    () => buildPayload({ content: 'x', rows: [{ type: 'random', pool: [] }] }),
    /przynajmniej jedną/
  );

  const rec = await createComposed(GUILD, {
    name: 'r',
    channelId: '800000000000000099',
    messageId: 'm-777',
    spec: { content: 'x', embeds: [], rows: [row] },
  });
  const run = (userId, messageId = 'm-777') => {
    const { out, interaction } = click(0, userId);
    interaction.message = { id: messageId };
    return handleComposedDropClick(interaction).then(() => out);
  };
  const first = await run(U1);
  assert.match(first.dms[0].content, /^\*\*[ab]\*\* vs \*\*[ab]\*\*\n\*kto lepszy\?\*$/);
  const second = await run(U1);
  assert.equal(second.dms.length, 0);
  assert.match(second.replies[0].content, /tylko raz/);
  assert.equal((await run(U2)).dms.length, 1); // another member can still click
  assert.match((await run(U1, 'm-unknown')).replies[0].content, /nie jest już aktywna/);
  assert.ok(rec.id > 0);
});

test('Random messages is a registered module: listed, on by default, switchable, and gates clicks', async () => {
  const { getModule } = await import('../src/modules/registry.js');
  const { setGuildModule } = await import('../src/db/modules.js');
  const { createComposed } = await import('../src/db/composedMessages.js');
  const { handleComposedDropClick, randomDropOverview } = await import('../src/modules/randomDrops.js');
  const mod = getModule('random-drops');
  assert.equal(mod.defaultEnabled, true);
  assert.equal(mod.configurable, true);

  const g = '800000000000000555';
  await createComposed(g, {
    name: 'Moja losowa',
    channelId: '800000000000000099',
    messageId: 'm-555',
    spec: { rows: [{ type: 'random', pool: ['a', 'b', 'c'], vsMode: true }] },
  });
  await createComposed(g, { name: 'Zwykła', channelId: '1', messageId: null, spec: { rows: [] } });
  const ov = await randomDropOverview(g);
  assert.equal(ov.messages.length, 1);
  assert.deepEqual(
    {
      name: ov.messages[0].name,
      entries: ov.messages[0].entries,
      vs: ov.messages[0].vsMode,
      pub: ov.messages[0].published,
    },
    { name: 'Moja losowa', entries: 3, vs: true, pub: true }
  );

  const { out, interaction } = click(0, U1, { guildId: g });
  interaction.message = { id: 'm-555' };
  await setGuildModule(g, 'random-drops', { enabled: false });
  await handleComposedDropClick(interaction);
  assert.match(out.replies[0].content, /wyłączone/);
  assert.equal(out.dms.length, 0);
});

test('VS mode appends the chosen number of different categories', async () => {
  const { rollResult } = await import('../src/modules/randomDrops.js');
  const base = { vs_mode: true, pool: ['a', 'b', 'c'], categories: ['k1', 'k2', 'k3', 'k4'] };
  assert.equal(
    rollResult({ ...base, categoryCount: 1 }, () => 0),
    '**a** vs **b**\n*k1*'
  );
  assert.equal(
    rollResult({ ...base, categoryCount: 3 }, () => 0),
    '**a** vs **b**\n*k1*\n*k2*\n*k3*'
  );
  assert.equal(
    rollResult(base, () => 0),
    '**a** vs **b**\n*k1*'
  ); // default is one
  for (let i = 0; i < 100; i++) {
    const cats = rollResult({ ...base, categoryCount: 3 })
      .split('\n')
      .slice(1);
    assert.equal(cats.length, 3);
    assert.equal(new Set(cats).size, 3);
  }
  // asking for more than exist gives all of them, once each
  assert.equal(rollResult({ ...base, categories: ['k1', 'k2'], categoryCount: 5 }).split('\n').length, 3);
  assert.equal(rollResult({ ...base, categories: [], categoryCount: 3 }).includes('\n'), false);
});

test('categoryCount is clamped to 1-10 and kept in the published message row', async () => {
  const { buildPayload } = await import('../src/modules/messageCreator.js');
  assert.equal(normaliseDrop({}).categoryCount, 1);
  assert.equal(normaliseDrop({ categoryCount: '3' }).categoryCount, 3);
  assert.equal(normaliseDrop({ categoryCount: 99 }).categoryCount, 10);
  assert.equal(normaliseDrop({ categoryCount: -4 }).categoryCount, 1);
  assert.equal(normaliseDrop({ categoryCount: 'abc' }).categoryCount, 1);
  const row = { type: 'random', pool: ['a', 'b'], vsMode: true, categories: ['k'], categoryCount: 2 };
  assert.ok(buildPayload({ rows: [row] }).payload.components.length === 1);
});
