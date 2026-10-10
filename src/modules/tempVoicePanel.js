import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import { registerComponent } from '../bot/lib/components.js';
import { resolveContext, canControl, targetActable } from '../bot/lib/tempVoiceCmd.js';
import { setLock, renameTemp, banFromChannel, unbanFromChannel, transferTemp } from './tempVoice.js';

const actions = [
  [
    ['lock', 'Zablokuj'],
    ['unlock', 'Odblokuj'],
    ['limit', 'Limit osób'],
  ],
  [['rename', 'Zmień nazwę']],
  [
    ['kick', 'Wyrzuć użytkownika'],
    ['ban', 'Zablokuj użytkownika'],
    ['unban', 'Odblokuj użytkownika'],
  ],
  [['transfer', 'Przekaż właściciela']],
];
export function voicePanel(channelId, ownerId) {
  return {
    allowedMentions: { parse: [] },
    embeds: [
      {
        title: 'Panel kanału głosowego',
        description: 'Zarządzaj swoim kanałem głosowym:',
        color: 0x5b7cfa,
        fields: [
          { name: 'Właściciel', value: `<@${ownerId}>`, inline: true },
          { name: 'Kanał głosowy', value: `<#${channelId}>`, inline: true },
        ],
      },
    ],
    components: actions.map((row) =>
      new ActionRowBuilder().addComponents(
        row.map(([action, label]) =>
          new ButtonBuilder()
            .setCustomId(`voice-panel:${channelId}:${action}`)
            .setLabel(label)
            .setStyle(['kick', 'ban'].includes(action) ? ButtonStyle.Danger : ButtonStyle.Secondary)
        )
      )
    ),
  };
}

export async function handleVoicePanel(interaction) {
  const [, channelId, action, stage, callerId] = interaction.customId.split(':');
  const reply = (content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (callerId && callerId !== interaction.user.id) return reply('These controls belong to another member.');
  const ctx = await resolveContext(interaction);
  if (ctx.error) return reply(ctx.error);
  if (ctx.channel.id !== channelId) return reply('Join this panel’s voice channel first.');
  if (!canControl(ctx)) return reply('Only the channel owner or a voice moderator can do that.');
  if (!actions.flat().some(([key]) => key === action)) return reply('Unknown control.');

  if (!stage && ['rename', 'limit'].includes(action)) {
    const input = new TextInputBuilder()
      .setCustomId('value')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setLabel(action === 'rename' ? 'Nazwa kanału' : 'Limit osób (0–99; 0 = bez limitu)')
      .setMaxLength(action === 'rename' ? 100 : 2)
      .setValue(action === 'rename' ? ctx.channel.name : String(ctx.channel.userLimit ?? 0));
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(`voice-panel:${channelId}:${action}:submit:${interaction.user.id}`)
        .setTitle(action === 'rename' ? 'Zmień nazwę kanału' : 'Ustaw limit osób')
        .addComponents(new ActionRowBuilder().addComponents(input))
    );
  }
  if (!stage && ['kick', 'ban', 'unban', 'transfer'].includes(action)) {
    return interaction.reply({
      content: 'Wybierz użytkownika:',
      flags: MessageFlags.Ephemeral,
      components: [
        new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId(`voice-panel:${channelId}:${action}:select:${interaction.user.id}`)
            .setPlaceholder('Wybierz użytkownika')
            .setMinValues(1)
            .setMaxValues(1)
        ),
      ],
    });
  }
  let value;
  let target;
  if (stage === 'submit') {
    value = interaction.fields.getTextInputValue('value').trim();
    if (action === 'limit' && (!/^\d{1,2}$/.test(value) || Number(value) > 99))
      return reply('Enter a whole number from 0 to 99.');
    if (action === 'rename' && !value) return reply('Enter a channel name.');
  }
  if (stage === 'select') {
    value = interaction.values[0];
    target = await interaction.guild.members.fetch(value).catch(() => null);
    if (['kick', 'transfer'].includes(action) && !ctx.channel.members.has(value))
      return reply('That member is not in this voice channel.');
    if (['kick', 'ban'].includes(action)) {
      const error = targetActable(ctx, target ?? { id: value, roles: { cache: new Map() } });
      if (error) return reply(error);
    }
    if (action === 'transfer' && target?.user.bot) return reply('Choose a human member as owner.');
    if (action === 'unban' && !ctx.row.banList.includes(value))
      return reply('That member is not banned here.');
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (action === 'lock' || action === 'unlock')
      await setLock(ctx.channel, interaction.guild, action === 'lock');
    else if (action === 'limit') await ctx.channel.setUserLimit(Number(value));
    else if (action === 'rename') await renameTemp(ctx.channel, value);
    else if (action === 'kick') await target.voice.disconnect(`Voice panel: ${interaction.user.tag}`);
    else if (action === 'ban') await banFromChannel(ctx.channel, ctx.row, value);
    else if (action === 'unban') await unbanFromChannel(ctx.channel, ctx.row, value);
    else if (action === 'transfer') {
      await transferTemp(ctx.channel, interaction.guild, ctx.row, value);
    }
    await interaction.editReply({ content: 'Voice channel updated.', allowedMentions: { parse: [] } });
  } catch {
    await interaction.editReply({
      content: 'Unable to update the channel. Check the bot’s channel permissions.',
    });
  }
}
export async function refreshVoicePanel(channel, ownerId) {
  const messages = await channel.messages.fetch({ limit: 50 });
  const panel = messages.find(
    (m) =>
      m.author.id === channel.client.user.id &&
      m.components.some((row) => row.components.some((c) => c.customId === `voice-panel:${channel.id}:lock`))
  );
  if (panel) await panel.edit(voicePanel(channel.id, ownerId));
}
registerComponent('temp-voice', 'voice-panel:', handleVoicePanel);
