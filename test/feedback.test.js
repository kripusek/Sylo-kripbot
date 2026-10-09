import './helpers/tmpDb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { normaliseFeedbackConfig, handleFeedback } from '../src/modules/feedback.js';
import { setGuildModule } from '../src/db/modules.js';
import { runtime } from '../src/runtime.js';
import { execute } from '../src/bot/events/interactionCreate.js';

const guildId = '900000000000000123';
const cfg = { panelChannel: '100000000000000001', reviewChannel: '100000000000000002', anonymous: false };

test('feedback is identified by default and preserves only a trusted panel ID', () => {
  assert.equal(normaliseFeedbackConfig({}).anonymous, false);
  assert.equal(normaliseFeedbackConfig({ anonymous: 'on' }).anonymous, true);
  assert.equal(
    normaliseFeedbackConfig(
      { panelChannel: cfg.panelChannel, panelMessageId: 'forged' },
      { panelChannel: cfg.panelChannel, panelMessageId: 'saved' }
    ).panelMessageId,
    'saved'
  );
});

test('feedback forms identify their privacy mode, route modal submissions, hide anonymous identities, and throttle repeats', async () => {
  const sent = [];
  const channel = {
    isTextBased: () => true,
    send: async (payload) => {
      sent.push(payload);
      return { id: 'log' };
    },
  };
  runtime.client = {
    guilds: {
      cache: new Collection([
        [guildId, { channels: { cache: new Collection([[cfg.reviewChannel, channel]]) }, members: {} }],
      ]),
    },
  };
  await setGuildModule(guildId, 'feedback', { enabled: true, config: cfg });
  let modal;
  const replies = [];
  const interaction = (customId, userId = '900000000000000456') => ({
    guildId,
    channelId: cfg.panelChannel,
    customId,
    user: { id: userId, tag: 'member#0001' },
    isButton: () => customId === 'feedback:open',
    isMessageComponent: () => customId === 'feedback:open',
    isModalSubmit: () => customId.startsWith('feedback:submit'),
    fields: {
      getTextInputValue: (key) => (key === 'subject' ? 'Staff complaint' : 'Please review this issue.'),
    },
    showModal: async (value) => {
      modal = value.toJSON();
    },
    deferReply: async () => {},
    reply: async (payload) => replies.push(payload.content),
    editReply: async (content) => replies.push(content),
  });
  await handleFeedback(interaction('feedback:open'));
  assert.match(modal.custom_id, /:identified$/);
  assert.match(modal.title, /identity/);
  await execute(interaction('feedback:submit:identified'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].toJSON().fields[0].value, /900000000000000456/);
  await handleFeedback(interaction('feedback:submit:identified'));
  assert.equal(sent.length, 1);
  assert.match(replies.at(-1), /one minute/);
  await setGuildModule(guildId, 'feedback', { config: { ...cfg, anonymous: true } });
  await handleFeedback(interaction('feedback:submit:identified', '900000000000000789'));
  assert.equal(sent.length, 1);
  assert.match(replies.at(-1), /privacy setting changed/);
  await handleFeedback(interaction('feedback:submit:anonymous', '900000000000000789'));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].embeds[0].toJSON().footer.text, 'Anonymous submission');
  assert.doesNotMatch(JSON.stringify(sent[1]), /900000000000000789|member#0001/);
  await setGuildModule(guildId, 'feedback', { enabled: false });
  await handleFeedback(interaction('feedback:open'));
  assert.match(replies.at(-1), /disabled/);
  runtime.client = null;
});

test('role-filtered feedback lists eligible people, paginates and records a validated rating', async () => {
  const { feedbackCandidates, feedbackPicker } = await import('../src/modules/feedback.js');
  const role = '100000000000000700';
  const targetId = '900000000000000111';
  const target = {
    id: targetId,
    displayName: 'Administrator',
    user: { tag: 'admin', username: 'admin', bot: false },
    roles: { cache: new Collection([[role, {}]]) },
  };
  const outsider = {
    id: '900000000000000112',
    user: { username: 'other', tag: 'other', bot: false },
    roles: { cache: new Collection() },
  };
  const members = new Collection([
    [targetId, target],
    [outsider.id, outsider],
  ]);
  const guild = { members: { cache: members, fetch: async (id) => members.get(id) }, memberCount: 2 };
  assert.deepEqual(
    feedbackCandidates(guild, [role]).map((member) => member.id),
    [targetId]
  );
  const page = feedbackPicker(
    Array.from({ length: 26 }, (_, index) => ({
      ...target,
      id: String(100000000000000000n + BigInt(index)),
    })),
    '900000000000000222',
    1
  );
  assert.equal(page.components[0].toJSON().components[0].options.length, 1);
  assert.match(page.content, /page 2\/2/);
  const config = { ...cfg, subjectRoles: [role] };
  await setGuildModule(guildId, 'feedback', { enabled: true, config });
  const sent = [];
  runtime.client = {
    guilds: {
      cache: new Collection([
        [
          guildId,
          {
            channels: {
              cache: new Collection([
                [
                  cfg.reviewChannel,
                  {
                    isTextBased: () => true,
                    send: async (payload) => {
                      sent.push(payload);
                      return { id: 'log' };
                    },
                  },
                ],
              ]),
            },
            members: {},
          },
        ],
      ]),
    },
  };
  let modal;
  let reply;
  const interaction = {
    guild,
    guildId,
    channelId: cfg.panelChannel,
    customId: 'feedback:person:900000000000000222',
    user: { id: '900000000000000222', tag: 'reviewer' },
    values: [targetId],
    isStringSelectMenu: () => true,
    isModalSubmit: () => true,
    showModal: async (value) => {
      modal = value.toJSON();
    },
    deferReply: async () => {},
    editReply: async (value) => {
      reply = value;
    },
    fields: { getTextInputValue: (key) => (key === 'rating' ? '6' : 'A useful opinion.') },
  };
  await handleFeedback(interaction);
  assert.equal(modal.components[0].components[0].custom_id, 'rating');
  assert.match(modal.custom_id, new RegExp(`${targetId}$`));
  interaction.customId = modal.custom_id;
  await handleFeedback(interaction);
  assert.match(reply, /from 0 to 5/);
  assert.equal(sent.length, 0);
  interaction.fields.getTextInputValue = (key) => (key === 'rating' ? '0' : 'A useful opinion.');
  await handleFeedback(interaction);
  assert.equal(sent.length, 1);
  const fields = sent[0].embeds[0].toJSON().fields;
  assert.equal(fields.find((field) => field.name === 'Rating').value, '0/5');
  assert.match(fields.find((field) => field.name === 'Feedback about').value, /admin/);
  runtime.client = null;
});
