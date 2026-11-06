import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, MessageFlags } from 'discord.js';
import { checkActable } from '../lib/moderation.js';
import { addCase } from '../../db/modCases.js';
import { clearTempBan } from '../../db/tempBans.js';

export const data = new SlashCommandBuilder()
  .setName('massban')
  .setDescription('Zbanuj do 10 obecnych członków serwera po ID lub wzmiankach.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addStringOption((o) => o.setName('users').setDescription('ID lub wzmianki, oddzielone spacją lub przecinkiem').setRequired(true).setMaxLength(300))
  .addStringOption((o) => o.setName('reason').setDescription('Powód banów').setRequired(true).setMaxLength(400));

export async function execute(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
    return interaction.reply({ content: 'Potrzebujesz uprawnienia Ban Members.', flags: MessageFlags.Ephemeral });
  }
  const raw = interaction.options.getString('users', true).trim();
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);
  const ids = tokens.map((token) => token.match(/^(?:<@!?(\d{17,20})>|(\d{17,20}))$/)).map((match) => match?.[1] || match?.[2]);
  if (!ids.length || ids.length > 10 || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    return interaction.reply({ content: 'Podaj od 1 do 10 różnych ID lub wzmianek członków serwera.', flags: MessageFlags.Ephemeral });
  }
  const reason = interaction.options.getString('reason', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const results = [];
  for (const id of ids) {
    let member;
    try { member = await interaction.guild.members.fetch({ user: id, force: true }); }
    catch { results.push(`${id}: nie udało się pobrać członka serwera`); continue; }
    const blocked = checkActable({ interaction, target: member, action: 'ban' });
    if (blocked || !member.bannable) { results.push(`${id}: brak uprawnień lub hierarchia ról`); continue; }
    try {
      await interaction.guild.bans.create(id, { reason: `${interaction.user.tag}: ${reason}` });
    } catch { results.push(`${id}: ban nie powiódł się`); continue; }
    try {
      await addCase({ guildId: interaction.guild.id, userId: id, moderatorId: interaction.user.id, action: 'ban', reason, detail: 'permanent' });
      await clearTempBan(interaction.guild.id, id);
      results.push(`${id}: zbanowany`);
    } catch {
      results.push(`${id}: zbanowany, ale zapis w bazie nie powiódł się`);
    }
  }
  await interaction.editReply({ content: `Wyniki masowego bana:\n${results.join('\n')}` });
}
