import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { addTempChannel } from '../src/db/tempVoice.js';
import { handleVoicePanel, voicePanel } from '../src/modules/tempVoicePanel.js';

const guildId = '811111111111111111';
const channelId = '822222222222222222';
const ownerId = '833333333333333333';
async function interaction(userId = ownerId, action = 'lock', stage = '') {
  await setGuildModule(guildId, 'temp-voice', { enabled: true });
  await addTempChannel({ channelId, guildId, hubId: '844444444444444444', ownerId });
  const calls = [];
  const channel = {
    id: channelId,
    name: 'Room',
    userLimit: 0,
    permissionOverwrites: { edit: async (...args) => calls.push(args) },
    setUserLimit: async (n) => calls.push(n),
  };
  const member = {
    id: userId,
    voice: { channelId },
    roles: { cache: new Map() },
    permissions: { has: () => false },
  };
  return {
    calls,
    channel,
    member,
    user: { id: userId },
    guildId,
    guild: { id: guildId, channels: { cache: new Map([[channelId, channel]]) } },
    customId: `voice-panel:${channelId}:${action}${stage}`,
    inGuild: () => true,
    reply: async (payload) => calls.push(payload),
    deferReply: async () => {},
    editReply: async (payload) => calls.push(payload),
    fields: { getTextInputValue: () => '100' },
  };
}
test('panel provides eight controls bound to its voice channel', () => {
  const panel = voicePanel(channelId, ownerId);
  const buttons = panel.components.flatMap((row) => row.toJSON().components);
  assert.equal(buttons.length, 8);
  assert.ok(buttons.every((button) => button.custom_id.startsWith(`voice-panel:${channelId}:`)));
});
test('non-owner cannot lock the channel', async () => {
  const i = await interaction('855555555555555555');
  await handleVoicePanel(i);
  assert.match(i.calls[0].content, /Only the channel owner/);
  assert.equal(i.calls.length, 1);
});
test('controls cannot act on a different voice channel', async () => {
  const i = await interaction();
  i.customId = 'voice-panel:866666666666666666:lock';
  await handleVoicePanel(i);
  assert.match(i.calls[0].content, /Join this panel/);
});
test('owner can lock the channel', async () => {
  const i = await interaction();
  await handleVoicePanel(i);
  assert.deepEqual(i.calls[0], [guildId, { Connect: false }]);
  assert.equal(i.calls[1].content, 'Voice channel updated.');
});
test('limit rejects values outside Discord limits', async () => {
  const i = await interaction(ownerId, 'limit', `:submit:${ownerId}`);
  await handleVoicePanel(i);
  assert.match(i.calls[0].content, /0 to 99/);
});
test('Discord permission failures are reported rather than claiming success', async () => {
  const i = await interaction();
  i.channel.permissionOverwrites.edit = async () => {
    throw new Error('Missing permissions');
  };
  await handleVoicePanel(i);
  assert.match(i.calls[0].content, /Unable to update/);
});
