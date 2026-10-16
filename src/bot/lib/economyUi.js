// Shared helpers for the economy slash commands (/ekonomia, /gry, /kup).
import { MessageFlags } from 'discord.js';
import { isModuleEnabled, getGuildModule } from '../../db/modules.js';
import { normaliseEconomy } from '../../modules/economy.js';

export const COLORS = { win: 0x57f287, lose: 0xed4245, draw: 0x99aab5, info: 0x5b7cfa, gold: 0xf1c40f };

export const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

/**
 * The guild's economy config, or null after telling the member the module is off.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function loadEconomy(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply(ephemeral('Użyj tej komendy na serwerze.'));
    return null;
  }
  if (!(await isModuleEnabled(interaction.guildId, 'economy'))) {
    await interaction.reply(ephemeral('Moduł Ekonomia nie jest włączony na tym serwerze.'));
    return null;
  }
  return normaliseEconomy((await getGuildModule(interaction.guildId, 'economy')).config);
}

/** Discord relative timestamp ("in 5 hours"), which the client keeps ticking down. */
export const relative = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
/** Discord short date-time in the viewer's own timezone. */
export const clock = (ms) => `<t:${Math.floor(ms / 1000)}:t>`;

/** Plain-text duration like "5 godz. 12 min" for places a live timestamp can't be used. */
export function durationText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} godz.` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '1 min';
}
