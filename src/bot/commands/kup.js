// /kup — spend coins in the server's role shop (roles and prices are set in the dashboard).
import {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { ensureAccount, debit, credit } from '../../db/economy.js';
import { formatCoins } from '../../modules/economy.js';
import { loadEconomy, ephemeral, COLORS } from '../lib/economyUi.js';
import { log } from '../../lib/log.js';

export const data = new SlashCommandBuilder()
  .setName('kup')
  .setDescription('Buy roles from the server shop with coins.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('rola')
      .setDescription('Buy a role from the shop.')
      .addRoleOption((o) => o.setName('rola').setDescription('The role to buy').setRequired(true))
  )
  .addSubcommand((s) => s.setName('lista').setDescription('List the roles you can buy.'));

async function lista(interaction, config) {
  if (!config.shop.enabled) return interaction.reply(ephemeral('Sklep jest wyłączony.'));
  const lines = config.shop.items
    .filter((item) => interaction.guild.roles.cache.has(item.roleId))
    .map((item) => {
      const owned = interaction.member.roles.cache.has(item.roleId) ? ' ✅ posiadasz' : '';
      return `<@&${item.roleId}> — ${formatCoins(config, item.price)}${owned}`;
    });
  if (!lines.length) return interaction.reply(ephemeral('Sklep jest pusty.'));
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle(`${config.currencyEmoji} Sklep z rolami`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Kupisz rolę komendą /kup rola' });
  return interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function rola(interaction, config) {
  if (!config.shop.enabled) return interaction.reply(ephemeral('Sklep jest wyłączony.'));
  const role = interaction.options.getRole('rola', true);
  const item = config.shop.items.find((i) => i.roleId === role.id);
  if (!item) return interaction.reply(ephemeral('Tej roli nie ma w sklepie. Zobacz `/kup lista`.'));
  const member = interaction.member;
  if (member.roles.cache.has(role.id)) return interaction.reply(ephemeral('Już masz tę rolę.'));
  const guildRole = interaction.guild.roles.cache.get(role.id);
  const me = interaction.guild.members.me;
  if (!guildRole || !me?.permissions.has(PermissionFlagsBits.ManageRoles) || !guildRole.editable)
    return interaction.reply(
      ephemeral('Nie mogę nadać tej roli — administrator musi sprawdzić uprawnienia bota.')
    );

  await ensureAccount(interaction.guildId, interaction.user.id, config.startingBalance);
  const left = await debit(interaction.guildId, interaction.user.id, item.price);
  if (left === null) return interaction.reply(ephemeral(`Potrzebujesz ${formatCoins(config, item.price)}.`));
  try {
    await member.roles.add(guildRole, 'Zakup w sklepie ekonomii');
  } catch (err) {
    log.warn('economy', 'shop role add failed, refunding:', err.message);
    await credit(interaction.guildId, interaction.user.id, item.price).catch(() => {});
    return interaction.reply(ephemeral('Nie udało się nadać roli — zwróciłem Ci monety.'));
  }
  const embed = new EmbedBuilder()
    .setColor(COLORS.win)
    .setTitle('🛒 Zakup udany')
    .setDescription(`Kupiłeś rolę <@&${role.id}> za ${formatCoins(config, item.price)}.`)
    .addFields({ name: 'Saldo', value: formatCoins(config, left) });
  return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await loadEconomy(interaction);
  if (!config) return;
  return interaction.options.getSubcommand() === 'lista'
    ? lista(interaction, config)
    : rola(interaction, config);
}
