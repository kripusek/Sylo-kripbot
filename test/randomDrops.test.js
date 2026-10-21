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
