import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { createAutoThread, normaliseAutoThreads, threadName } from '../src/modules/autoThreads.js';
const channelId = '111111111111111111';
function message(overrides = {}) {
  return {
    id: '222222222222222222',
    channelId,
    author: { username: 'kripus', bot: false },
    content: 'Hej',
    guild: { members: { me: {} } },
    channel: { type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) },
    startThread: async () => {},
    ...overrides,
  };
}
test('ignores unselected channels, bots, webhooks, system messages, threads and existing threads', async () => {
  for (const change of [
    { channelId: '333333333333333333' },
    { author: { bot: true } },
    { webhookId: '123' },
    { system: true },
    { hasThread: true },
    { channel: { type: ChannelType.PublicThread } },
  ]) {
    await createAutoThread(
      message({ ...change, startThread: () => assert.fail('must not create a thread') }),
      { channelIds: [channelId] }
    );
  }
});
test('checks permissions and creates a named thread with configured archive duration', async () => {
  await createAutoThread(
    message({
      channel: { type: ChannelType.GuildText, permissionsFor: () => ({ has: () => false }) },
      startThread: () => assert.fail('no permissions'),
    }),
    { channelIds: [channelId] }
  );
  let options;
  await createAutoThread(
    message({
      startThread: async (o) => {
        options = o;
      },
    }),
    { channelIds: [channelId], nameTemplate: '{author}: {message}', autoArchiveDuration: 60 }
  );
  assert.equal(options.name, 'kripus: Hej');
  assert.equal(options.autoArchiveDuration, 60);
});
test('prevents concurrent duplicate creation and releases guard after failure', async () => {
  let release;
  const m = message({
    startThread: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const first = createAutoThread(m, { channelIds: [channelId] });
  await createAutoThread({ ...m, startThread: () => assert.fail('duplicate') }, { channelIds: [channelId] });
  release();
  await first;
  await assert.rejects(
    createAutoThread(
      message({
        startThread: async () => {
          throw new Error('Discord error');
        },
      }),
      { channelIds: [channelId] }
    )
  );
  await createAutoThread(message(), { channelIds: [channelId] });
});
test('bounds config, deduplicates IDs and safely formats blank/attachment messages', () => {
  const cfg = normaliseAutoThreads({
    channelIds: [channelId, channelId, 'bad', 123],
    autoArchiveDuration: 3,
  });
  assert.deepEqual(cfg.channelIds, [channelId]);
  assert.equal(cfg.autoArchiveDuration, 1440);
  assert.equal(threadName(message({ content: '<@123>  \n' }), '{message}'), 'Załącznik');
  assert.equal(threadName(message({ content: 'a'.repeat(200) }), '{message}').length, 100);
});
