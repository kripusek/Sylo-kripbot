import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/modules/dispatch.js';
import { setGuildModule } from '../src/db/modules.js';
import { runtime } from '../src/runtime.js';
import {
  normaliseHoneypotConfig,
  evidenceText,
  collectRecentMessages,
  fetchEvidenceImages,
  imagesOf,
} from '../src/modules/honeypot.js';

const G = '900000000000000889';
const TRAP = '100000000000000011';
const GENERAL = '100000000000000012';
const LOG = '100000000000000013';
const SCAMMER = '300000000000000011';
const MIN = 60_000;

function channel(id, history = []) {
  const now = Date.now();
  const sent = [];
  const msgs = new Map(
    history.map((h) => [
      h.id,
      {
        id: h.id,
        author: { id: h.author },
        content: h.content,
        attachments: { size: h.files ?? 0 },
        createdTimestamp: now - h.ageMin * MIN,
        delete: async () => {},
      },
    ])
  );
  return {
    id,
    sent,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => msgs },
    bulkDelete: async () => {},
    send: async (payload) => {
      sent.push(payload);
      return { id: 'log-msg' };
    },
  };
}

function guildWith(channels) {
  const member = {
    id: SCAMMER,
    user: { id: SCAMMER, tag: 'scam#0001', displayAvatarURL: () => null, send: async () => {} },
    permissions: { has: () => false },
    roles: { cache: new Map() },
    moderatable: true,
    kickable: true,
    kick: async () => {},
  };
  const guild = {
    id: G,
    name: 'Test',
    channels: { cache: new Map(channels.map((c) => [c.id, c])), fetch: async () => null },
    members: { me: { permissions: { has: () => true } }, fetch: async () => member },
    bans: { create: async () => {} },
  };
  runtime.client = { guilds: { cache: new Map([[G, guild]]) } };
  return { guild, member };
}

test('logChannelId is validated', () => {
  assert.equal(normaliseHoneypotConfig({}).logChannelId, '');
  assert.equal(normaliseHoneypotConfig({ logChannelId: 'nope' }).logChannelId, '');
  assert.equal(normaliseHoneypotConfig({ logChannelId: LOG }).logChannelId, LOG);
});

test('evidenceText flattens text and defuses links and backticks', () => {
  assert.equal(evidenceText('hej\n`kod`  tu'), "`hej 'kod' tu`");
  assert.equal(evidenceText('', 2), '`(bez tekstu)` [+2 zał.]');
  assert.ok(evidenceText('x'.repeat(500)).length < 200);
});

test('collectRecentMessages reads the member’s messages inside the window without deleting', async () => {
  const general = channel(GENERAL, [
    { id: '1', author: SCAMMER, content: 'free nitro', ageMin: 2 },
    { id: '2', author: SCAMMER, content: 'too old', ageMin: 120 },
    { id: '3', author: 'other', content: 'hi', ageMin: 1 },
  ]);
  const { guild } = guildWith([general]);
  const found = await collectRecentMessages(guild, SCAMMER, 15);
  assert.deepEqual(
    found.map((m) => m.content),
    ['free nitro']
  );
});

test('a catch is posted to the log channel with the trap message and the deleted messages', async () => {
  const general = channel(GENERAL, [
    { id: '1', author: SCAMMER, content: 'MrBeast giveaway https://scam.example', ageMin: 3, files: 1 },
  ]);
  const log = channel(LOG);
  const trap = channel(TRAP);
  const { guild, member } = guildWith([general, log, trap]);
  await setGuildModule(G, 'honeypot', {
    enabled: true,
    config: {
      logChannelId: LOG,
      cleanup: { enabled: true, minutes: 15 },
      channels: [{ channelId: TRAP, action: 'kick', deleteMessage: false }],
    },
  });
  await dispatch('messageCreate', G, {
    partial: false,
    guild,
    channelId: TRAP,
    author: { id: SCAMMER },
    member,
    deletable: false,
    content: 'hello bots',
    attachments: { size: 0 },
  });
  assert.equal(log.sent.length, 1);
  const text = log.sent[0].embeds[0].data.description;
  assert.match(text, /scam#0001/);
  assert.match(text, /Napisał na pułapce\*\*\n`hello bots`/);
  assert.match(text, /Usunięte wiadomości \(1\)/);
  assert.match(text, /<#100000000000000012>: `MrBeast giveaway https:\/\/scam.example` \[\+1 zał.\]/);
  assert.deepEqual(log.sent[0].allowedMentions, { parse: [] });
});

test('no log channel configured means nothing extra is posted', async () => {
  const log = channel(LOG);
  const { guild, member } = guildWith([log, channel(TRAP)]);
  await setGuildModule(G, 'honeypot', {
    enabled: true,
    config: { channels: [{ channelId: TRAP, action: 'kick', deleteMessage: false }] },
  });
  await dispatch('messageCreate', G, {
    partial: false,
    guild,
    channelId: TRAP,
    author: { id: SCAMMER },
    member,
    deletable: false,
    content: 'x',
    attachments: { size: 0 },
  });
  assert.equal(log.sent.length, 0);
});

test('imagesOf keeps only image attachments as plain data', () => {
  const att = (contentType, url = 'https://cdn.discordapp.com/a/b.png') => ({ contentType, url, size: 10 });
  const message = {
    attachments: new Map([
      ['1', att('image/png')],
      ['2', att('video/mp4')],
      ['3', att('text/plain')],
    ]),
  };
  assert.deepEqual(imagesOf(message), [
    { url: 'https://cdn.discordapp.com/a/b.png', type: 'image/png', size: 10 },
  ]);
  assert.deepEqual(imagesOf({ attachments: { size: 2 } }), []);
});

test('fetchEvidenceImages downloads Discord-CDN images as spoilers and skips everything else', async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  try {
    const good = { url: 'https://cdn.discordapp.com/attachments/1/2/x.png', type: 'image/png', size: 3 };
    const { files, skipped } = await fetchEvidenceImages([
      [good, good], // duplicate is fetched once
      [{ url: 'https://evil.example/x.png', type: 'image/png', size: 3 }], // not Discord's CDN
      [{ url: 'https://cdn.discordapp.com/big.png', type: 'image/png', size: 99_000_000 }], // too big
    ]);
    assert.equal(files.length, 1);
    assert.equal(skipped, 2);
    assert.match(files[0].name, /^SPOILER_obrazek1\.png$/);
    assert.deepEqual(asked, [good.url]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a catch posts the caught member’s images, saved before deletion, with the log', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([9]).buffer,
  });
  try {
    const url = 'https://cdn.discordapp.com/attachments/1/2/scam.png';
    const general = channel(GENERAL, [{ id: '1', author: SCAMMER, content: 'look', ageMin: 2, files: 1 }]);
    const [m] = [...(await general.messages.fetch()).values()];
    m.attachments = new Map([['a', { contentType: 'image/png', url, size: 1 }]]);
    const logCh = channel(LOG);
    const { guild, member } = guildWith([general, logCh, channel(TRAP)]);
    await setGuildModule(G, 'honeypot', {
      enabled: true,
      config: {
        logChannelId: LOG,
        cleanup: { enabled: true, minutes: 15 },
        channels: [{ channelId: TRAP, action: 'kick', deleteMessage: false }],
      },
    });
    await dispatch('messageCreate', G, {
      partial: false,
      guild,
      channelId: TRAP,
      author: { id: SCAMMER },
      member,
      deletable: false,
      content: 'hello',
      attachments: { size: 0 },
    });
    assert.equal(logCh.sent[0].files.length, 1);
    assert.match(logCh.sent[0].files[0].name, /^SPOILER_/);
    assert.match(logCh.sent[0].embeds[0].data.description, /Obrazki:\*\* 1 dołączone/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
