// /ekonomia — virtual coins: balance, daily reward with a streak, richest
// members and transfers between members.
import { SlashCommandBuilder, EmbedBuilder, MessageFlags, InteractionContextType } from 'discord.js';
import {
  getAccount,
  ensureAccount,
  credit,
  debit,
  topBalances,
  balanceRank,
  accountCount,
} from '../../db/economy.js';
import { claimDaily, previewDaily, formatCoins, coinsText, MAX_PAYOUT } from '../../modules/economy.js';
import { loadEconomy, ephemeral, relative, clock, COLORS } from '../lib/economyUi.js';
import { log } from '../../lib/log.js';

const MEDALS = ['🥇', '🥈', '🥉'];
const TRANSFER_COOLDOWN_MS = 3000;
const lastTransfer = new Map();

export const data = new SlashCommandBuilder()
  .setName('ekonomia')
  .setDescription('Virtual coins: balance, daily reward, leaderboard and transfers.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('saldo')
      .setDescription('Show your coin balance (or another member’s).')
      .addUserOption((o) => o.setName('uzytkownik').setDescription('Whose balance to show'))
  )
  .addSubcommand((s) => s.setName('daily').setDescription('Claim your daily reward.'))
  .addSubcommand((s) => s.setName('top').setDescription('Show the richest members.'))
  .addSubcommand((s) =>
    s
      .setName('przekaz')
      .setDescription('Send coins to another member.')
      .addUserOption((o) => o.setName('komu').setDescription('Who receives the coins').setRequired(true))
      .addIntegerOption((o) =>
        o
          .setName('kwota')
          .setDescription('How many coins to send')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(MAX_PAYOUT)
      )
  );

/**
 * A short strip of the reward cycle around today's day, e.g.
 * "✅ Dzień 1 · 100   ▶️ Dzień 2 · 150   ▫️ Dzień 3 · 200".
 * @param {{ day: number, claimed: boolean }} at `day` is the day just claimed (claimed) or about to be (not).
 */
export function dailyTrack(config, { day, claimed }) {
  const { rewards } = config.daily;
  const n = rewards.length;
  const span = Math.min(n, 7);
  const start = Math.max(1, Math.min(day - 2, n - span + 1));
  const lines = [];
  for (let d = start; d < start + span; d += 1) {
    const mark = d < day || (d === day && claimed) ? '✅' : d === day ? '▶️' : '▫️';
    lines.push(`${mark} Dzień ${d} · ${rewards[d - 1].toLocaleString('pl-PL')}`);
  }
  const before = start > 1 ? `… ${start - 1} wcześniejszych dni\n` : '';
  const after = start + span <= n ? `\n… i ${n - (start + span - 1)} kolejnych` : '';
  return before + lines.join('\n') + after;
}

async function saldo(interaction, config) {
  const user = interaction.options.getUser('uzytkownik') ?? interaction.user;
  if (user.bot) return interaction.reply(ephemeral('Boty nie mają konta.'));
  const account = await getAccount(interaction.guildId, user.id);
  const [rank, total] = await Promise.all([
    balanceRank(interaction.guildId, account.balance),
    accountCount(interaction.guildId),
  ]);
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
    .setTitle(`${config.currencyEmoji} Saldo`)
    .setDescription(formatCoins(config, account.balance))
    .addFields({ name: 'Miejsce', value: account.balance > 0 ? `#${rank} z ${total}` : '—', inline: true });
  if (config.daily.enabled) {
    embed.addFields({
      name: 'Passa dziennych nagród',
      value: `🔥 ${account.dailyStreak} (rekord ${account.bestStreak})`,
      inline: true,
    });
  }
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function daily(interaction, config) {
  if (!config.daily.enabled) return interaction.reply(ephemeral('Dzienne nagrody są wyłączone.'));
  const now = Date.now();
  const result = await claimDaily(interaction.guildId, interaction.user.id, config, now);

  if (!result.ok) {
    const account = await getAccount(interaction.guildId, interaction.user.id);
    const preview = previewDaily(config.daily, account, now);
    const embed = new EmbedBuilder()
      .setColor(COLORS.draw)
      .setTitle('⏳ Dzienna nagroda już odebrana')
      .setDescription(
        `Kolejny odbiór ${relative(result.nextClaimAt)} (${clock(result.nextClaimAt)}).\n` +
          `Odbierz najpóźniej ${relative(preview.streakEndsAt)}, żeby nie stracić passy.`
      )
      .addFields(
        { name: 'Passa', value: `🔥 ${account.dailyStreak}`, inline: true },
        { name: 'Następna nagroda', value: coinsText(config, preview.reward), inline: true }
      );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  const nextClaimAt = now + config.daily.cooldownHours * 3_600_000;
  const embed = new EmbedBuilder()
    .setColor(COLORS.win)
    .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
    .setTitle(`${config.currencyEmoji} Dzienna nagroda odebrana!`)
    .setDescription(
      `Dzień **${result.day}** · **+${result.reward.toLocaleString('pl-PL')}** ${config.currencyName}` +
        (result.streakBroken ? '\n💔 Poprzednia passa wygasła — zaczynasz od nowa.' : '')
    )
    .addFields(
      { name: 'Passa', value: `🔥 ${result.streak} (rekord ${result.bestStreak})`, inline: true },
      { name: 'Saldo', value: formatCoins(config, result.balance), inline: true },
      { name: 'Kolejny odbiór', value: `${relative(nextClaimAt)} (${clock(nextClaimAt)})`, inline: true },
      { name: 'Nagrody', value: dailyTrack(config, { day: result.day, claimed: true }) }
    );
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function top(interaction, config) {
  const rows = await topBalances(interaction.guildId, 10);
  if (!rows.length) return interaction.reply(ephemeral('Nikt jeszcze nie ma monet.'));
  const lines = rows.map(
    (r, i) => `${MEDALS[i] ?? `**${i + 1}.**`} <@${r.userId}> — ${formatCoins(config, r.balance)}`
  );
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle(`${config.currencyEmoji} Najbogatsi`)
    .setDescription(lines.join('\n'));
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function przekaz(interaction, config) {
  const { transfers } = config;
  if (!transfers.enabled) return interaction.reply(ephemeral('Przekazywanie monet jest wyłączone.'));
  const target = interaction.options.getUser('komu', true);
  const amount = interaction.options.getInteger('kwota', true);
  if (target.bot) return interaction.reply(ephemeral('Nie możesz przekazać monet botowi.'));
  if (target.id === interaction.user.id)
    return interaction.reply(ephemeral('Nie możesz przekazać monet sobie.'));
  if (amount < transfers.minAmount)
    return interaction.reply(
      ephemeral(`Minimalna kwota przelewu to ${coinsText(config, transfers.minAmount)}.`)
    );
  const key = `${interaction.guildId}:${interaction.user.id}`;
  if (Date.now() - (lastTransfer.get(key) ?? 0) < TRANSFER_COOLDOWN_MS)
    return interaction.reply(ephemeral('Zwolnij — odczekaj chwilę przed kolejnym przelewem.'));
  lastTransfer.set(key, Date.now());

  const fee = Math.floor((amount * transfers.feePercent) / 100);
  const received = amount - fee;
  await ensureAccount(interaction.guildId, interaction.user.id, config.startingBalance);
  const left = await debit(interaction.guildId, interaction.user.id, amount);
  if (left === null) return interaction.reply(ephemeral('Nie masz tylu monet.'));
  try {
    await credit(interaction.guildId, target.id, received, config.startingBalance);
  } catch (err) {
    log.error('economy', 'transfer credit failed, refunding sender:', err);
    await credit(interaction.guildId, interaction.user.id, amount).catch(() => {});
    return interaction.reply(ephemeral('Przelew się nie udał — zwróciłem Ci monety.'));
  }
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`${config.currencyEmoji} Przelew`)
    .setDescription(
      `<@${interaction.user.id}> przekazuje ${formatCoins(config, received)} dla <@${target.id}>.` +
        (fee ? `\nProwizja: ${formatCoins(config, fee)}.` : '')
    )
    .addFields({ name: 'Twoje saldo', value: formatCoins(config, left) });
  return interaction.reply({ embeds: [embed], allowedMentions: { users: [target.id] } });
}

const HANDLERS = { saldo, daily, top, przekaz };

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await loadEconomy(interaction);
  if (!config) return;
  return HANDLERS[interaction.options.getSubcommand()](interaction, config);
}
