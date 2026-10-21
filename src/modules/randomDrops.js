// Random drops: post a message with a button; each member can press it once and
// gets a random line from the drop's list in a DM.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { registerComponent } from '../bot/lib/components.js';
import { getDrop, claimDrop, setDropMessage } from '../db/randomDrops.js';
import { postToChannel } from './lib/send.js';

export const POOL_MAX_LINES = 200;
export const POOL_MAX_LINE = 1000;
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
  };
}

export const pickRandom = (pool, rng = Math.random) => pool[Math.floor(rng() * pool.length)];

/** What a click produces: one random line, or in VS mode "A vs B" plus a random category. */
export function rollResult(drop, rng = Math.random) {
  if (!drop.vs_mode) return pickRandom(drop.pool, rng);
  const first = Math.floor(rng() * drop.pool.length);
  const rest = drop.pool.filter((_, i) => i !== first);
  const second = pickRandom(rest, rng);
  const category = drop.categories.length ? pickRandom(drop.categories, rng) : '';
  return `**${drop.pool[first]}** vs **${second}**${category ? `\n*${category}*` : ''}`;
}

const minimum = (drop) => (drop.vs_mode ? 2 : 1);

export function buildDropPayload(drop) {
  return {
    embeds: [{ color: 0x5865f2, description: drop.text }],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${PREFIX}${drop.id}`)
          .setLabel(drop.button_label || DEFAULT_BUTTON)
          .setStyle(ButtonStyle.Primary)
      ),
    ],
  };
}

/**
 * Post (or refresh) the drop's message in its channel.
 * @returns {Promise<'sent'|'updated'>}
 */
export async function publishDrop(guild, drop) {
  if (!drop.channel_id) throw new Error('Wybierz kanał, na który wysłać wiadomość.');
  if (drop.pool.length < minimum(drop))
    throw new Error(
      drop.vs_mode
        ? 'W trybie VS dodaj przynajmniej dwie linie do losowania.'
        : 'Dodaj przynajmniej jedną linię do losowania.'
    );
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

const say = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

export async function handleDropClick(interaction) {
  const drop = await getDrop(Number(interaction.customId.slice(PREFIX.length)));
  if (!drop || drop.guild_id !== interaction.guildId)
    return say(interaction, 'Ta wiadomość nie jest już aktywna.');
  if (drop.pool.length < minimum(drop)) return say(interaction, 'Lista do losowania jest za krótka.');
  const result = rollResult(drop);
  if (!(await claimDrop(drop.id, interaction.user.id, drop.guild_id, result)))
    return say(interaction, 'Już odebrałeś/aś swoją wiadomość — można kliknąć tylko raz.');
  try {
    await interaction.user.send({ content: result, allowedMentions: { parse: [] } });
  } catch {
    return say(interaction, `Nie mogę wysłać Ci DM, więc oto Twoja wiadomość:\n${result}`);
  }
  return say(interaction, 'Wysłałem Ci wiadomość w DM ✅');
}

registerComponent('random-drops', PREFIX, handleDropClick);
