import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { setGuildModule } from '../src/db/modules.js';
import { ticketGuildsForDM } from '../src/modules/tickets.js';

test('DM destinations remain available without membership and disappear when tickets are disabled', async () => {
  const previous = runtime.client;
  const support = {
    id: '910000000000000001',
    members: {
      fetch: async () => {
        throw new Error('Unknown Member');
      },
    },
  };
  const disabled = { id: '910000000000000002' };
  runtime.client = {
    guilds: {
      cache: new Map([
        [support.id, support],
        [disabled.id, disabled],
      ]),
    },
  };
  try {
    await setGuildModule(support.id, 'tickets', { enabled: true, config: {} });
    await setGuildModule(disabled.id, 'tickets', { enabled: false, config: {} });
    assert.deepEqual(await ticketGuildsForDM(), [support]);
    await setGuildModule(support.id, 'tickets', { enabled: false, config: {} });
    assert.deepEqual(await ticketGuildsForDM(), []);
  } finally {
    runtime.client = previous;
  }
});

test('"Accept DM tickets" off hides the server from DMs; it is on unless explicitly off', async () => {
  const previous = runtime.client;
  const guild = { id: '910000000000000003' };
  runtime.client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  try {
    await setGuildModule(guild.id, 'tickets', { enabled: true, config: {} });
    assert.deepEqual(await ticketGuildsForDM(), [guild]); // old configs without the key still accept DMs
    await setGuildModule(guild.id, 'tickets', { enabled: true, config: { dmEnabled: false } });
    assert.deepEqual(await ticketGuildsForDM(), []);
    await setGuildModule(guild.id, 'tickets', { enabled: true, config: { dmEnabled: true } });
    assert.deepEqual(await ticketGuildsForDM(), [guild]);
  } finally {
    runtime.client = previous;
  }
});
