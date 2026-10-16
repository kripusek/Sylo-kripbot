import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/modules/dispatch.js';
import { setGuildModule } from '../src/db/modules.js';
import { normaliseHoneypotConfig, sweepRecentMessages } from '../src/modules/honeypot.js';

const G = '900000000000000888';
const TRAP = '100000000000000001';
const GENERAL = '100000000000000002';
const NOPERM = '100000000000000003';
const SCAMMER = '300000000000000001';
const OTHER = '300000000000000002';

const MIN = 60_000;

/** Channel whose history is a list of { id, author, ageMin }; tracks deletions. */
function fakeChannel(id, history, { canModerate = true } = {}) {
  const now = Date.now();
  const msgs = new Map(
    history.map((h) => [
      h.id,
      {
        id: h.id,
        author: { id: h.author },
        createdTimestamp: now - h.ageMin * MIN,
        delete: async () => void deleted.push(h.id),
      },
    ])
  );
  const deleted = [];
  return {
    id,
    deleted,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => canModerate }),
    messages: { fetch: async () => msgs },
    bulkDelete: async (list) => void deleted.push(...list.map((m) => m.id)),
  };
}

function fakeGuild(channels, { bans } = {}) {
  const member = {
    id: SCAMMER,
    user: { id: SCAMMER, tag: 'scam#0001', displayAvatarURL: () => null, send: async () => {} },
    permissions: { has: () => false },
    roles: { cache: new Map() },
    moderatable: true,
    kickable: true,
    kick: async () => {},
  };
  return {
    id: G,
    name: 'Test',
    channels: { cache: new Map(channels.map((c) => [c.id, c])), fetch: async () => null },
    members: { me: { permissions: { has: () => true } }, fetch: async () => member },
    bans: { create: async (id, opts) => void bans?.push({ id, ...opts }) },
  };
}

const history = () => [
  { id: 'a1', author: SCAMMER, ageMin: 1 },
  { id: 'a2', author: SCAMMER, ageMin: 5 },
  { id: 'old', author: SCAMMER, ageMin: 90 }, // outside the window
  { id: 'b1', author: OTHER, ageMin: 2 }, // somebody else
];

test('cleanup config: off by default, minutes clamped', () => {
  assert.deepEqual(normaliseHoneypotConfig({}).cleanup, { enabled: false, minutes: 15 });
  assert.deepEqual(normaliseHoneypotConfig({ cleanup: { enabled: true, minutes: 99999 } }).cleanup, {
    enabled: true,
    minutes: 1440,
  });
  assert.equal(normaliseHoneypotConfig({ cleanup: { enabled: 'on', minutes: 0 } }).cleanup.enabled, false);
  assert.equal(normaliseHoneypotConfig({ cleanup: { enabled: true, minutes: 0 } }).cleanup.minutes, 1);
});

test('sweepRecentMessages deletes only the member’s messages inside the window', async () => {
  const general = fakeChannel(GENERAL, history());
  const trap = fakeChannel(TRAP, [{ id: 't1', author: SCAMMER, ageMin: 0 }]);
  const locked = fakeChannel(NOPERM, history(), { canModerate: false });
  const n = await sweepRecentMessages(fakeGuild([general, trap, locked]), SCAMMER, 15);
  assert.equal(n, 3);
  assert.deepEqual(general.deleted.sort(), ['a1', 'a2']); // not "old", not the other member
  assert.deepEqual(trap.deleted, ['t1']); // a single message goes through delete()
  assert.deepEqual(locked.deleted, []); // no Manage Messages -> skipped
});

async function catchScammer(config, guild) {
  await setGuildModule(G, 'honeypot', {
    enabled: true,
    config: { channels: [{ channelId: TRAP, action: 'kick', deleteMessage: false }], ...config },
  });
  const message = {
    partial: false,
    guild,
    channelId: TRAP,
    author: { id: SCAMMER },
    member: await guild.members.fetch(),
    deletable: false,
  };
  await dispatch('messageCreate', G, message);
}

test('kick with cleanup enabled also removes recent messages in other channels', async () => {
  const general = fakeChannel(GENERAL, history());
  await catchScammer({ cleanup: { enabled: true, minutes: 15 } }, fakeGuild([general]));
  assert.deepEqual(general.deleted.sort(), ['a1', 'a2']);
});

test('kick without cleanup leaves messages alone', async () => {
  const general = fakeChannel(GENERAL, history());
  await catchScammer({ cleanup: { enabled: false, minutes: 15 } }, fakeGuild([general]));
  assert.deepEqual(general.deleted, []);
});

test('ban uses Discord’s own deleteMessageSeconds instead of scanning channels', async () => {
  const general = fakeChannel(GENERAL, history());
  const bans = [];
  await setGuildModule(G, 'honeypot', {
    enabled: true,
    config: {
      cleanup: { enabled: true, minutes: 30 },
      channels: [{ channelId: TRAP, action: 'ban', deleteMessage: false }],
    },
  });
  const guild = fakeGuild([general], { bans });
  await dispatch('messageCreate', G, {
    partial: false,
    guild,
    channelId: TRAP,
    author: { id: SCAMMER },
    member: await guild.members.fetch(),
    deletable: false,
  });
  assert.equal(bans.length, 1);
  assert.equal(bans[0].deleteMessageSeconds, 30 * 60);
  assert.deepEqual(general.deleted, []); // no manual sweep needed
});
