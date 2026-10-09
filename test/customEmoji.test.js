import './helpers/tmpDb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { parseEmoji, buildRoleComponents } from '../src/modules/roles.js';
const emojiId = '100000000000009999';
const emoji = { id: emojiId, name: 'kripus', animated: true, toString: () => `<a:kripus:${emojiId}>` };
const guild = { emojis: { cache: new Collection([[emojiId, emoji]]) } };

test('reaction roles accept Discord custom emoji mentions, names, IDs and CDN URLs', () => {
  for (const input of [
    `<a:kripus:${emojiId}>`,
    ':kripus:',
    'kripus',
    emojiId,
    `kripus:${emojiId}`,
    `https://cdn.discordapp.com/emojis/${emojiId}.webp?size=96`,
  ]) {
    const result = parseEmoji(input, guild);
    assert.equal(result.key, emojiId, input);
    assert.equal(result.display, emoji.toString(), input);
  }
  assert.equal(parseEmoji(':missing:', guild), null);
  assert.equal(parseEmoji('✅', guild).key, '✅');
  assert.equal(parseEmoji('🇵🇱', guild).key, '🇵🇱');
  const pair = { ...parseEmoji(emojiId, guild), roleId: '100000000000000700', label: 'Role' };
  const component = buildRoleComponents(guild, { id: 'set', style: 'buttons', pairs: [pair] })[0].toJSON()
    .components[0];
  assert.equal(component.emoji.id, emojiId);
});
