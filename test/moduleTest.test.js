import './helpers/tmpDb.js';
import './helpers/openMode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { sendModuleTest } from '../src/bot/lib/moduleTest.js';
import { runtime } from '../src/runtime.js';

test('logging test uses enabled event routes and retains fallback/error handling', async () => {
  const sent = [];
  const channel = (id) => ({
    id,
    name: id,
    isTextBased: () => true,
    send: async () => {
      sent.push(id);
      return { id: 'message' };
    },
  });
  const guild = {
    id: '820000000000000001',
    members: {},
    channels: {
      cache: new Map([
        ['event', channel('event')],
        ['default', channel('default')],
      ]),
    },
  };
  runtime.client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  try {
    await setGuildModule(guild.id, 'logging', {
      config: {
        channel: '',
        events: { messageCreate: true, memberJoin: false },
        eventChannels: { messageCreate: 'event', memberJoin: 'disabled' },
      },
    });
    assert.equal((await sendModuleTest(guild, 'logging')).ok, true);
    assert.deepEqual(sent, ['event']);
    await setGuildModule(guild.id, 'logging', { config: { channel: 'default' } });
    assert.equal((await sendModuleTest(guild, 'logging')).channelName, 'default');
    await setGuildModule(guild.id, 'logging', { config: {} });
    assert.equal((await sendModuleTest(guild, 'logging')).reason, 'no-channel');
    await setGuildModule(guild.id, 'logging', {
      config: { events: { messageCreate: true }, eventChannels: { messageCreate: 'missing' } },
    });
    assert.equal((await sendModuleTest(guild, 'logging')).reason, 'send-failed');
  } finally {
    runtime.client = null;
  }
});
