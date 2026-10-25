// /steam — link your Steam account (with Steam's own sign-in) so /gry cs2 knows
// which matches are yours.
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
} from 'discord.js';
import { config } from '../../config.js';
import { getSteamLink, removeSteamLink, pendingCs2BetOf, recentCs2Bets } from '../../db/cs2.js';
import { signSteamToken } from '../../modules/lib/steamLink.js';
import { ephemeral } from '../lib/economyUi.js';

export const data = new SlashCommandBuilder()
  .setName('steam')
  .setDescription('Link your Steam account for CS2 bets.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('polacz').setDescription('Link your Steam account (Steam sign-in).'))
  .addSubcommand((s) => s.setName('status').setDescription('Show your linked Steam account and CS2 stake.'))
  .addSubcommand((s) => s.setName('odlacz').setDescription('Unlink your Steam account.'));

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const { guildId } = interaction;
  const userId = interaction.user.id;

  if (sub === 'polacz') {
    if (!config.dashboardUrl)
      return interaction.reply(
        ephemeral('Administrator musi ustawić `DASHBOARD_URL`, żeby łączenie Steama działało.')
      );
    if (await pendingCs2BetOf(guildId, userId))
      return interaction.reply(ephemeral('Masz aktywną stawkę CS2 — zmienisz konto po jej rozliczeniu.'));
    const url = `${config.dashboardUrl}/steam/start?t=${encodeURIComponent(signSteamToken(guildId, userId))}`;
    return interaction.reply({
      ...ephemeral(
        'Kliknij przycisk i zaloguj się przez Steam — bot dostaje tylko numer Twojego konta, nigdy hasło. Link działa 10 minut.'
      ),
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Zaloguj przez Steam').setURL(url)
        ),
      ],
    });
  }

  const steamId = await getSteamLink(guildId, userId);
  if (sub === 'odlacz') {
    if (!steamId) return interaction.reply(ephemeral('Nie masz połączonego konta Steam.'));
    if (await pendingCs2BetOf(guildId, userId))
      return interaction.reply(ephemeral('Masz aktywną stawkę CS2 — odłączysz konto po jej rozliczeniu.'));
    await removeSteamLink(guildId, userId);
    return interaction.reply(ephemeral('Konto Steam odłączone.'));
  }

  if (!steamId)
    return interaction.reply(ephemeral('Nie masz połączonego konta Steam. Użyj **/steam polacz**.'));
  const pending = await pendingCs2BetOf(guildId, userId);
  const last = (await recentCs2Bets(guildId, userId, 3)).filter((b) => b.status !== 'pending');
  const lines = [
    `Konto Steam: [${steamId}](https://steamcommunity.com/profiles/${steamId})`,
    pending
      ? `⏳ Aktywna stawka CS2: **${pending.amount}** — czekam na Twój następny mecz.`
      : 'Brak aktywnej stawki CS2.',
    ...last.map(
      (b) =>
        `• ${b.amount} → ${b.status === 'won' ? `wygrana ${b.payout}` : b.status === 'lost' ? 'przegrana' : 'zwrot'}`
    ),
  ];
  return interaction.reply(ephemeral(lines.join('\n')));
}
