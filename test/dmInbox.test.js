import { startWebApp } from './helpers/webApp.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendDirectMessage, recordIncomingDm, DmInboxError } from '../src/modules/dmInbox.js';
import { listDmThreads, listDmMessages, dmUnreadCount, markDmRead } from '../src/db/dmInbox.js';

const U1 = '700000000000000001';
const U2 = '700000000000000002';
const GUILD = '800000000000000001';

const stubGuild = (members) => ({
  id: GUILD,
  members: { fetch: async (id) => members[id] ?? Promise.reject(new Error('Unknown Member')) },
});
const member = (id, { bot = false, fail = false, sent = [] } = {}) => ({
  id,
  user: {
    bot,
    send: async (payload) => {
      if (fail) throw new Error('Cannot send messages to this user');
      sent.push(payload);
    },
  },
});

test('sendDirectMessage DMs a member and records the message', async () => {
  const sent = [];
  const guild = stubGuild({ [U1]: member(U1, { sent }) });
  const stored = await sendDirectMessage(guild, U1, '  cześć  ', 'admin');
  assert.equal(sent[0].content, 'cześć');
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.equal(stored.direction, 'out');
  const rows = await listDmMessages(GUILD, U1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'cześć');
});

test('sendDirectMessage refuses bad input, non-members, bots and blocked DMs', async () => {
  const guild = stubGuild({ [U1]: member(U1, { fail: true }), [U2]: member(U2, { bot: true }) });
  await assert.rejects(() => sendDirectMessage(guild, 'abc', 'x'), DmInboxError);
  await assert.rejects(() => sendDirectMessage(guild, U1, '   '), DmInboxError);
  await assert.rejects(() => sendDirectMessage(guild, U1, 'x'.repeat(2001)), DmInboxError);
  await assert.rejects(
    () => sendDirectMessage(guild, '700000000000000099', 'hi'),
    /nie jest na tym serwerze/
  );
  await assert.rejects(() => sendDirectMessage(guild, U2, 'hi'), /bota/);
  await assert.rejects(() => sendDirectMessage(guild, U1, 'hi'), /zablokowane/);
});

test('replies are stored only for members with a conversation', async () => {
  const stranger = {
    guildId: null,
    author: { id: '700000000000000555', bot: false, username: 'x' },
    content: 'hej',
  };
  assert.equal(await recordIncomingDm(stranger), false);

  const reply = {
    guildId: null,
    author: { id: U1, bot: false, username: 'kripusek' },
    content: 'odpowiedź',
    attachments: new Map([['1', { url: 'https://cdn.example/a.png' }]]),
  };
  assert.equal(await recordIncomingDm(reply), true);
  assert.equal(await recordIncomingDm({ ...reply, guildId: GUILD }), false); // guild message
  assert.equal(await recordIncomingDm({ ...reply, author: { ...reply.author, bot: true } }), false);

  const rows = await listDmMessages(GUILD, U1);
  assert.equal(rows.at(-1).direction, 'in');
  assert.equal(rows.at(-1).content, 'odpowiedź\nhttps://cdn.example/a.png');
  assert.equal(await dmUnreadCount(GUILD), 1);
  await markDmRead(GUILD, U1);
  assert.equal(await dmUnreadCount(GUILD), 0);
  assert.equal((await listDmThreads(GUILD))[0].user_id, U1);
  assert.equal((await listDmMessages(GUILD, U1, rows.at(-1).id)).length, 0);
});

test('dashboard routes send, list, read and delete a conversation', async () => {
  const app = await startWebApp();
  try {
    const sent = [];
    app.guild.members.fetch = async (id) => member(id, { sent });
    const json = (path, body) =>
      fetch(`${app.base}/guilds/${GID}/dm${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });

    const bad = await json('/send', { userId: U2, content: '' });
    assert.equal(bad.status, 400);

    const ok = await json('/send', { userId: U2, content: 'siema' });
    assert.equal(ok.status, 201);
    assert.equal(sent[0].content, 'siema');

    const threads = (await (await json('/threads')).json()).threads;
    assert.equal(threads.length, 1);
    assert.equal(threads[0].userId, U2);

    const msgs = await (await json(`/${U2}/messages?after=0`)).json();
    assert.equal(msgs.messages.length, 1);
    assert.equal(msgs.messages[0].direction, 'out');

    assert.equal(
      (await (await fetch(`${app.base}/guilds/${GID}/dm`)).text()).includes('id="dm-inbox"'),
      true
    );

    assert.equal((await json(`/${U2}/delete`, {})).status, 200);
    assert.equal((await json(`/${U2}/delete`, {})).status, 404);
    assert.equal((await (await json('/threads')).json()).threads.length, 0);
  } finally {
    app.close();
  }
});
