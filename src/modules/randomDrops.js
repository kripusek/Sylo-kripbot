// Random drops: post a message with a button; each member can press it once and
// gets a random line from the drop's list in a DM.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { registerComponent } from '../bot/lib/components.js';
import {
  getDrop,
  claimDrop,
  setDropMessage,
  countClaims,
  listDrops,
  resetClaims,
} from '../db/randomDrops.js';
import { getComposedByMessage, getComposed, listComposed } from '../db/composedMessages.js';
import { isModuleEnabled } from '../db/modules.js';
import { postToChannel } from './lib/send.js';

export const POOL_MAX_LINES = 200;
export const POOL_MAX_LINE = 1000;
export const CATEGORY_COUNT_MAX = 10;
export const DEFAULT_TEXT = 'Kliknij przycisk, a dostaniesz ode mnie wiadomość w DM.';
export const DEFAULT_BUTTON = 'Losuj';
const PREFIX = 'rdrop:';

/** Clean the editable fields of a drop. `pool` may be an array or one-per-line text. */
export function normaliseDrop(raw = {}) {
  const toLines = (v, max) =>
    (Array.isArray(v) ? v : String(v ?? '').split(/\r?\n/))
      .map((l) => String(l).trim().slice(0, POOL_MAX_LINE))
      .filter(Boolean)
      .slice(0, max);
  return {
    name:
      String(raw.name ?? '')
        .trim()
        .slice(0, 60) || 'Losowa wiadomość',
    channelId: /^\d{17,20}$/.test(raw.channelId ?? '') ? raw.channelId : '',
    text:
      String(raw.text ?? '')
        .trim()
        .slice(0, 1500) || DEFAULT_TEXT,
    buttonLabel:
      String(raw.buttonLabel ?? '')
        .trim()
        .slice(0, 80) || DEFAULT_BUTTON,
    pool: toLines(raw.pool, POOL_MAX_LINES),
    vsMode: raw.vsMode === true || raw.vsMode === 'on' || raw.vsMode === 'true' || raw.vsMode === 1,
    categories: toLines(raw.categories, POOL_MAX_LINES),
    categoryCount: Math.max(1, Math.min(CATEGORY_COUNT_MAX, Math.floor(Number(raw.categoryCount)) || 1)),
  };
}

export const pickRandom = (pool, rng = Math.random) => pool[Math.floor(rng() * pool.length)];

/** `count` different entries of `list`, in random order. */
function pickMany(list, count, rng) {
  const pool = [...list];
  const out = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

/**
 * What a click produces: one random line, or in VS mode "A vs B" plus
 * `categoryCount` different random categories (as many as exist).
 */
export function rollResult(drop, rng = Math.random) {
  if (!drop.vs_mode) return pickRandom(drop.pool, rng);
  const first = Math.floor(rng() * drop.pool.length);
  const rest = drop.pool.filter((_, i) => i !== first);
  const second = pickRandom(rest, rng);
  const categories = pickMany(drop.categories, drop.categoryCount ?? 1, rng);
  return `**${drop.pool[first]}** vs **${second}**${categories.map((c) => `\n*${c}*`).join('')}`;
}

const minimum = (drop) => (drop.vs_mode || drop.vsMode ? 2 : 1);

/** A Polish reason why this drop can't be posted yet, or '' when it is fine. */
export function dropTooShort(drop) {
  if (drop.pool.length >= minimum(drop)) return '';
  return minimum(drop) === 2
    ? 'W trybie VS dodaj przynajmniej dwie linie do losowania.'
    : 'Dodaj przynajmniej jedną linię do losowania.';
}

export const dropButton = (customId, label) =>
  new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label || DEFAULT_BUTTON)
    .setStyle(ButtonStyle.Primary);

export function buildDropPayload(drop) {
  return {
    embeds: [{ color: 0x5865f2, description: drop.text }],
    components: [new ActionRowBuilder().addComponents(dropButton(`${PREFIX}${drop.id}`, drop.button_label))],
  };
}

/**
 * Post (or refresh) the drop's message in its channel.
 * @returns {Promise<'sent'|'updated'>}
 */
export async function publishDrop(guild, drop) {
  if (!drop.channel_id) throw new Error('Wybierz kanał, na który wysłać wiadomość.');
  const problem = dropTooShort(drop);
  if (problem) throw new Error(problem);
  const payload = buildDropPayload(drop);
  if (drop.message_id) {
    const channel = guild.channels.cache.get(drop.channel_id);
    const existing = await channel?.messages?.fetch(drop.message_id).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      return 'updated';
    }
  }
  const posted = await postToChannel(guild.id, drop.channel_id, payload);
  if (!posted) throw new Error('Nie mogę wysłać wiadomości na ten kanał. Sprawdź uprawnienia bota.');
  await setDropMessage(drop.id, drop.channel_id, posted.messageId);
  return 'sent';
}

/** Overview for the module page: every Embed message that has a random button, plus the older standalone drops. */
export async function randomDropOverview(guildId) {
  const messages = [];
  for (const rec of await listComposed(guildId, 200)) {
    const row = (rec.spec?.rows ?? []).find((r) => r.type === 'random');
    if (!row) continue;
    const drop = normaliseDrop({ ...row, buttonLabel: row.label });
    messages.push({
      id: rec.id,
      name: rec.name || 'Bez nazwy',
      channelId: rec.channel_id,
      published: Boolean(rec.message_id),
      vsMode: drop.vsMode,
      entries: drop.pool.length,
      claims: await countClaims(-rec.id),
    });
  }
  const standalone = (await listDrops(guildId)).map((d) => ({ id: d.id, name: d.name, claims: d.claims }));
  return { messages, standalone };
}

/**
 * Reset the one-click limit of a drop so people can click again.
 * @param {'message'|'standalone'} kind  an Embed message with a random button, or an older standalone drop
 * @param {string|null} userId  only this member, or everyone when empty
 * @returns {Promise<number|null>} how many members were reset, or null when the drop isn't in this guild
 */
export async function resetDropLimit(guildId, kind, id, userId = null) {
  const num = Number(id);
  if (!Number.isInteger(num) || num < 1) return null;
  if (userId && !/^\d{17,20}$/.test(userId)) return null;
  if (kind === 'standalone') {
    const drop = await getDrop(num);
    return drop?.guild_id === guildId ? resetClaims(guildId, num, userId || null) : null;
  }
  const rec = await getComposed(guildId, num);
  const hasRandom = (rec?.spec?.rows ?? []).some((r) => r.type === 'random');
  return rec && hasRandom ? resetClaims(guildId, -num, userId || null) : null;
}

const say = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

async function deliver(interaction, drop, claimId) {
  if (!(await isModuleEnabled(interaction.guildId, 'random-drops')))
    return say(interaction, 'Losowe wiadomości są teraz wyłączone na tym serwerze.');
  if (dropTooShort({ ...drop, vsMode: drop.vs_mode }))
    return say(interaction, 'Lista do losowania jest za krótka.');
  const result = rollResult(drop);
  if (!(await claimDrop(claimId, interaction.user.id, interaction.guildId, result)))
    return say(interaction, 'Już odebrałeś/aś swoją wiadomość — można kliknąć tylko raz.');
  try {
    await interaction.user.send({ content: result, allowedMentions: { parse: [] } });
  } catch {
    return say(interaction, `Nie mogę wysłać Ci DM, więc oto Twoja wiadomość:\n${result}`);
  }
  return say(interaction, 'Wysłałem Ci wiadomość w DM ✅');
}

/** Button from the standalone "Losowe wiadomości" page (customId rdrop:<id>). */
export async function handleDropClick(interaction) {
  const drop = await getDrop(Number(interaction.customId.slice(PREFIX.length)));
  if (!drop || drop.guild_id !== interaction.guildId)
    return say(interaction, 'Ta wiadomość nie jest już aktywna.');
  return deliver(interaction, drop, drop.id);
}

/**
 * Button from an Embed message (customId rdrop:msg): the list lives in the saved
 * message's `random` row. Claims use the negated message id so they can never
 * collide with the standalone drops' ids in the same table.
 */
export async function handleComposedDropClick(interaction) {
  const rec = await getComposedByMessage(interaction.guildId, interaction.message.id);
  const row = (rec?.spec?.rows ?? []).find((r) => r.type === 'random');
  if (!row) return say(interaction, 'Ta wiadomość nie jest już aktywna.');
  const drop = normaliseDrop({ ...row, buttonLabel: row.label });
  return deliver(interaction, { ...drop, vs_mode: drop.vsMode }, -rec.id);
}

registerComponent('random-drops', PREFIX, handleDropClick);
registerComponent('random-drops', 'rdrop:msg', handleComposedDropClick);
