// /gry — mini-games played with the economy's virtual coins against the bot.
// The coins have no real-world value. Every stake is taken with one atomic
// guarded debit before the round and the payout credited after it, so a game
// can never be played with coins the member doesn't have.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  InteractionContextType,
} from 'discord.js';
import { ensureAccount, debit, credit } from '../../db/economy.js';
import { formatCoins, MAX_PAYOUT } from '../../modules/economy.js';
import { loadEconomy, ephemeral, COLORS } from '../lib/economyUi.js';
import {
  payoutFor,
  coinflip,
  guessNumber,
  rps,
  dice,
  slots,
  roulette,
  cups,
  poker,
  blackjackDeal,
  blackjackHit,
  blackjackStand,
  blackjackValue,
  handLabel,
  GUESS_MAX,
  GUESS_MULTIPLIER,
  SLOTS_JACKPOT_MULTIPLIER,
  SLOTS_PAIR_MULTIPLIER,
  CUPS_MULTIPLIER,
  ROULETTE_POCKETS,
  rouletteMultiplier,
} from '../../modules/lib/economyGames.js';
import { log } from '../../lib/log.js';
import { CS2_LOSE_PICK_MULTIPLIER } from '../../modules/lib/cs2.js';
import { placeCs2Bet, CS2_MODES, matchGapMs } from '../../modules/cs2Bets.js';

const BLACKJACK_TIMEOUT_MS = 60_000;
const SIDE_LABEL = { orzel: 'Orzeł', reszka: 'Reszka' };
const RPS_LABEL = { kamien: '🪨 Kamień', papier: '📄 Papier', nozyce: '✂️ Nożyce' };
const COLOR_LABEL = { czerwone: '🔴 Czerwone', czarne: '⚫ Czarne', zielone: '🟢 Zielone' };
const ROULETTE_LABEL = { ...COLOR_LABEL, parzyste: '2️⃣ Parzyste', nieparzyste: '1️⃣ Nieparzyste' };

const stake = (description) => (o) =>
  o.setName('stawka').setDescription(description).setRequired(true).setMinValue(1).setMaxValue(MAX_PAYOUT);
const BET = 'How many coins to bet';

export const data = new SlashCommandBuilder()
  .setName('gry')
  .setDescription('Mini-games played for virtual coins.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('coinflip')
      .setDescription('Coin flip, 50/50.')
      .addIntegerOption(stake(BET))
      .addStringOption((o) =>
        o
          .setName('wybor')
          .setDescription('Your call')
          .setRequired(true)
          .addChoices({ name: 'Orzeł', value: 'orzel' }, { name: 'Reszka', value: 'reszka' })
      )
  )
  .addSubcommand((s) =>
    s
      .setName('zgadnij')
      .setDescription('Guess a number from 1 to 5 (pays 4x).')
      .addIntegerOption((o) =>
        o
          .setName('liczba')
          .setDescription('Your guess (1-5)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(GUESS_MAX)
      )
      .addIntegerOption(stake(BET))
  )
  .addSubcommand((s) =>
    s
      .setName('rps')
      .setDescription('Rock, paper, scissors against the bot (free).')
      .addStringOption((o) =>
        o
          .setName('wybor')
          .setDescription('Your move')
          .setRequired(true)
          .addChoices(
            { name: 'Kamień', value: 'kamien' },
            { name: 'Papier', value: 'papier' },
            { name: 'Nożyce', value: 'nozyce' }
          )
      )
  )
  .addSubcommand((s) =>
    s.setName('kostka').setDescription('Roll a d6 against the bot.').addIntegerOption(stake(BET))
  )
  .addSubcommand((s) =>
    s.setName('sloty').setDescription('Slots (jackpot 5x, pair 2x).').addIntegerOption(stake(BET))
  )
  .addSubcommand((s) =>
    s.setName('blackjack').setDescription('Blackjack: Hit or Stand.').addIntegerOption(stake(BET))
  )
  .addSubcommand((s) =>
    s.setName('poker').setDescription('Five-card poker against the bot.').addIntegerOption(stake(BET))
  )
  .addSubcommand((s) =>
    s
      .setName('ruletka')
      .setDescription('Roulette: a colour, even/odd or an exact number.')
      .addIntegerOption(stake(BET))
      .addStringOption((o) =>
        o
          .setName('typ')
          .setDescription('What to bet on (or pick an exact number instead)')
          .addChoices(
            { name: 'Czerwone', value: 'czerwone' },
            { name: 'Czarne', value: 'czarne' },
            { name: 'Zielone', value: 'zielone' },
            { name: 'Parzyste', value: 'parzyste' },
            { name: 'Nieparzyste', value: 'nieparzyste' }
          )
      )
      .addIntegerOption((o) =>
        o
          .setName('liczba')
          .setDescription('Exact number to bet on (0-14), pays 14x')
          .setMinValue(0)
          .setMaxValue(ROULETTE_POCKETS - 1)
      )
  )
  .addSubcommand((s) =>
    s
      .setName('cs2')
      .setDescription('Bet on winning your next CS2 match (needs /steam polacz).')
      .addIntegerOption(stake(BET))
      .addStringOption((o) =>
        o
          .setName('tryb')
          .setDescription('Game mode of the match (decides the payout)')
          .setRequired(true)
          .addChoices(
            ...Object.entries(CS2_MODES).map(([value, m]) => ({
              name: `${m.label} (x${m.multiplier})`,
              value,
            }))
          )
      )
      .addUserOption((o) =>
        o.setName('gracz').setDescription("Bet on this member's match instead of your own").setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName('czy_wygra')
          .setDescription('Will the player win? (tak pays the mode multiplier, nie pays x1.5)')
          .setRequired(false)
          .addChoices({ name: 'tak', value: 'win' }, { name: 'nie', value: 'lose' })
      )
  )
  .addSubcommand((s) =>
    s
      .setName('kubki')
      .setDescription('Guess which cup (1-3) hides the ball.')
      .addIntegerOption((o) =>
        o.setName('kubek').setDescription('Cup number (1-3)').setRequired(true).setMinValue(1).setMaxValue(3)
      )
      .addIntegerOption(stake(BET))
  );

// One round at a time per member, plus a short cooldown between rounds.
const active = new Set();
const lastRound = new Map();

/** Why this member can't start a round right now, or null if they can. */
function blockReason(interaction, config, bet) {
  const { games } = config;
  if (!games.enabled) return 'Gry są wyłączone na tym serwerze.';
  if (games.channelIds.length && !games.channelIds.includes(interaction.channelId))
    return `Gry są dostępne tylko na kanałach: ${games.channelIds.map((id) => `<#${id}>`).join(', ')}.`;
  if (bet != null) {
    if (bet < games.minBet) return `Minimalna stawka to ${formatCoins(config, games.minBet)}.`;
    if (bet > games.maxBet) return `Maksymalna stawka to ${formatCoins(config, games.maxBet)}.`;
  }
  const key = `${interaction.guildId}:${interaction.user.id}`;
  if (active.has(key)) return 'Masz już trwającą grę — dokończ ją najpierw.';
  const wait = games.cooldownSeconds * 1000 - (Date.now() - (lastRound.get(key) ?? 0));
  if (wait > 0) return `Odczekaj jeszcze ${Math.ceil(wait / 1000)} s przed kolejną grą.`;
  return null;
}

function resultEmbed(config, { title, lines, bet, payout, balance }) {
  const net = payout - bet;
  const color = net > 0 ? COLORS.win : net < 0 ? COLORS.lose : COLORS.draw;
  const verdict =
    net > 0
      ? `✅ Wygrywasz **+${net.toLocaleString('pl-PL')}** ${config.currencyEmoji}`
      : net < 0
        ? `❌ Tracisz **${bet.toLocaleString('pl-PL')}** ${config.currencyEmoji}`
        : '🤝 Zwrot stawki';
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription([...lines, '', verdict].join('\n'))
    .addFields(
      { name: 'Stawka', value: formatCoins(config, bet), inline: true },
      { name: 'Saldo', value: formatCoins(config, balance), inline: true }
    );
}

/**
 * Take the stake, run `play()`, pay out, reply. `play` returns
 * `{ title, lines, multiplier }`.
 */
async function instantRound(interaction, config, bet, play) {
  const blocked = blockReason(interaction, config, bet);
  if (blocked) return interaction.reply(ephemeral(blocked));
  const key = `${interaction.guildId}:${interaction.user.id}`;
  active.add(key);
  try {
    await ensureAccount(interaction.guildId, interaction.user.id, config.startingBalance);
    const left = await debit(interaction.guildId, interaction.user.id, bet);
    if (left === null) return await interaction.reply(ephemeral('Nie masz tylu monet.'));
    let round;
    try {
      round = play();
    } catch (err) {
      await credit(interaction.guildId, interaction.user.id, bet).catch(() => {});
      throw err;
    }
    const payout = payoutFor(bet, round.multiplier);
    const balance = payout > 0 ? await credit(interaction.guildId, interaction.user.id, payout) : left;
    return await interaction.reply({
      embeds: [resultEmbed(config, { title: round.title, lines: round.lines, bet, payout, balance })],
      allowedMentions: { parse: [] },
    });
  } finally {
    active.delete(key);
    lastRound.set(key, Date.now());
  }
}

const GAMES = {
  coinflip: (interaction, config, bet) => {
    const choice = interaction.options.getString('wybor', true);
    return instantRound(interaction, config, bet, () => {
      const r = coinflip(choice);
      return {
        title: '🪙 Rzut monetą',
        lines: [`Wybrałeś: **${SIDE_LABEL[choice]}**`, `Wypadło: **${SIDE_LABEL[r.result]}**`],
        multiplier: r.multiplier,
      };
    });
  },
  zgadnij: (interaction, config, bet) => {
    const choice = interaction.options.getInteger('liczba', true);
    return instantRound(interaction, config, bet, () => {
      const r = guessNumber(choice);
      return {
        title: '🔢 Zgadnij liczbę',
        lines: [`Twój typ: **${choice}**`, `Wylosowano: **${r.number}** (wygrana ${GUESS_MULTIPLIER}x)`],
        multiplier: r.multiplier,
      };
    });
  },
  kostka: (interaction, config, bet) =>
    instantRound(interaction, config, bet, () => {
      const r = dice();
      return {
        title: '🎲 Kostka',
        lines: [`Ty: **${r.player}** 🎲 Bot: **${r.bot}**`],
        multiplier: r.multiplier,
      };
    }),
  sloty: (interaction, config, bet) =>
    instantRound(interaction, config, bet, () => {
      const r = slots();
      const note =
        r.outcome === 'jackpot'
          ? `🎉 **JACKPOT** (${SLOTS_JACKPOT_MULTIPLIER}x)`
          : r.outcome === 'pair'
            ? `Para (${SLOTS_PAIR_MULTIPLIER}x)`
            : 'Brak trafienia';
      return { title: '🎰 Sloty', lines: [`[ ${r.reels.join(' | ')} ]`, note], multiplier: r.multiplier };
    }),
  poker: (interaction, config, bet) =>
    instantRound(interaction, config, bet, () => {
      const r = poker();
      return {
        title: '🃏 Poker',
        lines: [
          `Ty: ${handLabel(r.player)} — **${r.playerHand.name}**`,
          `Bot: ${handLabel(r.bot)} — **${r.botHand.name}**`,
        ],
        multiplier: r.multiplier,
      };
    }),
  ruletka: (interaction, config, bet) => {
    const name = interaction.options.getString('typ');
    const exact = interaction.options.getInteger('liczba');
    if ((name === null) === (exact === null))
      return interaction.reply(
        ephemeral('Wybierz dokładnie jedno: `typ` (kolor, parzyste/nieparzyste) albo `liczba`.')
      );
    const type = exact === null ? name : exact;
    return instantRound(interaction, config, bet, () => {
      const r = roulette(type);
      return {
        title: '🎡 Ruletka',
        lines: [
          `Postawiłeś na: **${exact === null ? ROULETTE_LABEL[name] : `liczbę ${exact}`}** (${rouletteMultiplier(type)}x)`,
          `Wypadło: **${r.pocket}** ${COLOR_LABEL[r.color]}`,
        ],
        multiplier: r.multiplier,
      };
    });
  },
  kubki: (interaction, config, bet) => {
    const choice = interaction.options.getInteger('kubek', true);
    return instantRound(interaction, config, bet, () => {
      const r = cups(choice);
      const show = [1, 2, 3].map((n) => (n === r.ball ? '⚪' : '🥤')).join('  ');
      return {
        title: '🥤 Kubki',
        lines: [
          `Wybrałeś kubek **${choice}** (wygrana ${CUPS_MULTIPLIER}x)`,
          `Piłka była pod kubkiem **${r.ball}**`,
          show,
        ],
        multiplier: r.multiplier,
      };
    });
  },
};

// ---------------------------------------------------------------- rps (free) ----
async function rpsGame(interaction, config) {
  if (!config.games.enabled) return interaction.reply(ephemeral('Gry są wyłączone na tym serwerze.'));
  const choice = interaction.options.getString('wybor', true);
  const r = rps(choice);
  const verdict =
    r.outcome === 'win' ? '✅ Wygrywasz!' : r.outcome === 'lose' ? '❌ Przegrywasz.' : '🤝 Remis.';
  const embed = new EmbedBuilder()
    .setColor(r.outcome === 'win' ? COLORS.win : r.outcome === 'lose' ? COLORS.lose : COLORS.draw)
    .setTitle('✂️ Kamień, papier, nożyce')
    .setDescription(`Ty: **${RPS_LABEL[choice]}**\nBot: **${RPS_LABEL[r.bot]}**\n\n${verdict}`)
    .setFooter({ text: 'Zabawa bez stawki.' });
  return interaction.reply({ embeds: [embed] });
}

// ----------------------------------------------------------------- blackjack ----
const OUTCOME_LABEL = {
  blackjack: '🂡 Blackjack! Wypłata 2,5x',
  win: 'Wygrywasz',
  push: 'Remis',
  lose: 'Krupier wygrywa',
  bust: 'Przekroczyłeś 21',
};

function blackjackEmbed(config, state, bet, { hideDealer }) {
  const player = blackjackValue(state.player).total;
  const dealerShown = hideDealer ? [state.dealer[0]] : state.dealer;
  const dealerText = hideDealer
    ? `${handLabel(dealerShown)} 🂠`
    : `${handLabel(dealerShown)} (**${blackjackValue(state.dealer).total}**)`;
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('♠️ Blackjack')
    .setDescription(`Ty: ${handLabel(state.player)} (**${player}**)\nKrupier: ${dealerText}`)
    .addFields({ name: 'Stawka', value: formatCoins(config, bet), inline: true });
}

function blackjackButtons(disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('bj-hit')
        .setLabel('Dobierz')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId('bj-stand')
        .setLabel('Pasuj')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    ),
  ];
}

async function blackjackGame(interaction, config, bet) {
  const blocked = blockReason(interaction, config, bet);
  if (blocked) return interaction.reply(ephemeral(blocked));
  const { guildId } = interaction;
  const userId = interaction.user.id;
  const key = `${guildId}:${userId}`;
  active.add(key);
  const release = () => {
    active.delete(key);
    lastRound.set(key, Date.now());
  };

  let left;
  try {
    await ensureAccount(guildId, userId, config.startingBalance);
    left = await debit(guildId, userId, bet);
  } catch (err) {
    release();
    throw err;
  }
  if (left === null) {
    release();
    return interaction.reply(ephemeral('Nie masz tylu monet.'));
  }

  let settled = false;
  const state = blackjackDeal();
  const settle = async () => {
    if (settled) return null;
    settled = true;
    const payout = payoutFor(bet, state.result.multiplier);
    let balance = left;
    try {
      if (payout > 0) balance = await credit(guildId, userId, payout);
    } catch (err) {
      log.error('economy', 'blackjack payout failed:', err);
    } finally {
      release();
    }
    const base = blackjackEmbed(config, state, bet, { hideDealer: false });
    const net = payout - bet;
    return base
      .setColor(net > 0 ? COLORS.win : net < 0 ? COLORS.lose : COLORS.draw)
      .setDescription(
        `${base.data.description}\n\n${OUTCOME_LABEL[state.result.outcome]} — ` +
          (net > 0
            ? `**+${net.toLocaleString('pl-PL')}**`
            : net < 0
              ? `**-${bet.toLocaleString('pl-PL')}**`
              : 'zwrot stawki')
      )
      .addFields({ name: 'Saldo', value: formatCoins(config, balance), inline: true });
  };

  try {
    if (state.done) {
      return await interaction.reply({ embeds: [await settle()], allowedMentions: { parse: [] } });
    }
    await interaction.reply({
      embeds: [blackjackEmbed(config, state, bet, { hideDealer: true })],
      components: blackjackButtons(),
    });
    const reply = await interaction.fetchReply();
    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: BLACKJACK_TIMEOUT_MS,
    });

    collector.on('collect', async (i) => {
      if (i.user.id !== userId) {
        return i.reply(ephemeral('To nie Twoja gra.')).catch(() => {});
      }
      try {
        if (i.customId === 'bj-hit') blackjackHit(state);
        else blackjackStand(state);
        if (state.done) {
          // Settle first: stop() emits 'end' synchronously and that handler must see it settled.
          const finalEmbed = await settle();
          collector.stop('done');
          await i.update({ embeds: [finalEmbed], components: blackjackButtons(true) });
        } else {
          await i.update({ embeds: [blackjackEmbed(config, state, bet, { hideDealer: true })] });
        }
      } catch (err) {
        log.error('economy', 'blackjack interaction failed:', err);
        collector.stop('error');
      }
    });

    collector.on('end', async (_collected, reason) => {
      if (settled) return;
      // Timed out (or errored) mid-round: play it out as a stand so the stake is settled.
      blackjackStand(state);
      try {
        await interaction
          .editReply({ embeds: [await settle()], components: blackjackButtons(true) })
          .catch(() => {});
      } catch (err) {
        log.error('economy', `blackjack ${reason} settle failed:`, err);
      }
    });
  } catch (err) {
    if (!settled) {
      // Never got the round on screen: give the stake back.
      settled = true;
      await credit(guildId, userId, bet).catch(() => {});
      release();
    }
    throw err;
  }
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
// ---------------------------------------------------------------- cs2 (match bet) ----
async function cs2Game(interaction) {
  const config = await loadEconomy(interaction);
  if (!config) return;
  const bet = interaction.options.getInteger('stawka', true);
  const mode = interaction.options.getString('tryb', true);
  const target = interaction.options.getUser('gracz');
  const pick = interaction.options.getString('czy_wygra') ?? 'win';
  if (target?.bot) return interaction.reply(ephemeral('Na bota nie postawisz.'));
  const result = await placeCs2Bet(
    interaction.guildId,
    interaction.user.id,
    bet,
    mode,
    interaction.channelId ?? '',
    { targetId: target?.id ?? '', pick }
  );
  if (!result.ok) return interaction.reply(ephemeral(result.error));
  const minutes = matchGapMs(mode) / 60_000;
  const onOther = Boolean(target) && target.id !== interaction.user.id;
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('🎯 Stawka na mecz CS2')
        .setDescription(
          (onOther
            ? `Postawiłeś ${formatCoins(config, bet)}, że ${target} **${pick === 'win' ? 'wygra' : 'przegra'}** swój następny mecz **${CS2_MODES[mode].label}**.\n`
            : `Postawiłeś ${formatCoins(config, bet)} na wygraną w swoim następnym meczu **${CS2_MODES[mode].label}**.\n`) +
            `Wygrana: **${pick === 'lose' && onOther ? CS2_LOSE_PICK_MULTIPLIER : CS2_MODES[mode].multiplier}x**, remis zwraca stawkę. Liczy się pierwszy mecz tego trybu, który skończy się ` +
            `co najmniej ${minutes} min po stawce. Wynik ogłoszę na tym kanale (dane: Leetify).`
        )
        .setFooter({ text: `Saldo: ${result.balance}` }),
    ],
    flags: ephemeral('').flags,
  });
}

export async function execute(interaction) {
  const config = await loadEconomy(interaction);
  if (!config) return;
  const sub = interaction.options.getSubcommand();
  if (sub === 'rps') return rpsGame(interaction, config);
  if (sub === 'cs2') return cs2Game(interaction);
  const bet = interaction.options.getInteger('stawka', true);
  if (sub === 'blackjack') return blackjackGame(interaction, config, bet);
  return GAMES[sub](interaction, config, bet);
}

export const _internals = { active, lastRound };
