// /rynki — prediction markets played with the economy's virtual coins.
// Bets are placed with the buttons under a market's message; these subcommands
// list the open markets, a member's own bets and the best predictors.
import { SlashCommandBuilder, EmbedBuilder, InteractionContextType } from 'discord.js';
import { isModuleEnabled, getGuildModule } from '../../db/modules.js';
import { listMarkets, userBets, topPredictors, optionPools } from '../../db/markets.js';
import { normaliseEconomy, formatCoins } from '../../modules/economy.js';
import { describePools } from '../../modules/lib/marketMath.js';
import { ephemeral, COLORS } from '../lib/economyUi.js';

export const data = new SlashCommandBuilder()
  .setName('rynki')
  .setDescription('Prediction markets played for virtual coins.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('lista').setDescription('Show the open markets.'))
  .addSubcommand((s) => s.setName('moje').setDescription('Show your recent bets.'))
  .addSubcommand((s) => s.setName('ranking').setDescription('Show the best predictors on this server.'));

const link = (m, guildId) =>
  m.channelId && m.messageId
    ? `[${m.question}](https://discord.com/channels/${guildId}/${m.channelId}/${m.messageId})`
    : m.question;

async function lista(interaction, economy) {
  const markets = await listMarkets(interaction.guildId, { openOnly: true, limit: 15 });
  if (!markets.length) return interaction.reply(ephemeral('Nie ma teraz żadnych otwartych rynków.'));
  const lines = [];
  for (const m of markets) {
    const stats = describePools(await optionPools(m.id, m.options.length));
    const top = m.options
      .map((o, i) => ({ label: o.label, share: stats.options[i].share }))
      .sort((a, b) => b.share - a.share)[0];
    lines.push(
      `**#${m.id}** ${link(m, interaction.guildId)}\n` +
        `Pula: ${formatCoins(economy, stats.total)}` +
        (stats.total ? ` · prowadzi **${top.label}** (${Math.round(top.share * 100)}%)` : '') +
        (m.closesAt ? ` · do <t:${Math.floor(m.closesAt / 1000)}:R>` : '')
    );
  }
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('📈 Otwarte rynki')
        .setDescription(lines.join('\n\n')),
    ],
    flags: ephemeral('').flags,
  });
}

async function moje(interaction, economy) {
  const bets = await userBets(interaction.guildId, interaction.user.id, 15);
  if (!bets.length) return interaction.reply(ephemeral('Nie masz jeszcze żadnych zakładów.'));
  const lines = bets.map((b) => {
    const pick = b.options[b.optionIdx]?.label ?? '?';
    let state = '⏳ trwa';
    if (b.status === 'cancelled') state = '↩️ zwrócono';
    else if (b.status === 'resolved')
      state =
        b.payout > b.amount
          ? `✅ +${formatCoins(economy, b.payout - b.amount)}`
          : b.payout === b.amount
            ? '↩️ zwrócono'
            : '❌ przegrana';
    return `**#${b.marketId}** ${b.question.slice(0, 80)}\n${pick} — ${formatCoins(economy, b.amount)} · ${state}`;
  });
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('🎟️ Twoje zakłady')
        .setDescription(lines.join('\n\n')),
    ],
    flags: ephemeral('').flags,
  });
}

async function ranking(interaction, economy) {
  const board = await topPredictors(interaction.guildId, 10);
  if (!board.length) return interaction.reply(ephemeral('Nikt jeszcze nie rozliczył żadnego zakładu.'));
  const medals = ['🥇', '🥈', '🥉'];
  const lines = board.map(
    (r, i) =>
      `${medals[i] ?? `**${i + 1}.**`} <@${r.userId}> — ${r.profit >= 0 ? '+' : '−'}${formatCoins(economy, Math.abs(r.profit))} (${r.bets} zakł.)`
  );
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.gold)
        .setTitle('🏆 Najlepsi typerzy')
        .setDescription(lines.join('\n')),
    ],
    allowedMentions: { parse: [] },
  });
}

export async function execute(interaction) {
  if (!(await isModuleEnabled(interaction.guildId, 'markets')))
    return interaction.reply(ephemeral('Rynki nie są włączone na tym serwerze.'));
  const economy = normaliseEconomy((await getGuildModule(interaction.guildId, 'economy')).config);
  const sub = interaction.options.getSubcommand();
  if (sub === 'lista') return lista(interaction, economy);
  if (sub === 'moje') return moje(interaction, economy);
  return ranking(interaction, economy);
}
