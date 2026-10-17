// /relay — start, stop and inspect the voice relay (see modules/voiceRelay.js).
import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
} from 'discord.js';
import { isModuleEnabled, getGuildModule, setGuildModule } from '../../db/modules.js';
import {
  normaliseVoiceRelay,
  reconcileGuild,
  relayStatus,
  relayBotConfigured,
  relayInviteUrl,
  RelayError,
} from '../../modules/voiceRelay.js';
import { runtime } from '../../runtime.js';

export const data = new SlashCommandBuilder()
  .setName('relay')
  .setDescription('Carry one voice channel into another with a second bot.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) =>
    s
      .setName('start')
      .setDescription('Start relaying audio from the input channel to the output channel.')
      .addChannelOption((o) =>
        o
          .setName('wejscie')
          .setDescription('Input channel the main bot listens in')
          .addChannelTypes(ChannelType.GuildVoice)
      )
      .addChannelOption((o) =>
        o
          .setName('wyjscie')
          .setDescription('Output channel the relay bot speaks in')
          .addChannelTypes(ChannelType.GuildVoice)
      )
      .addBooleanOption((o) => o.setName('dwukierunkowo').setDescription('Let both channels hear each other'))
  )
  .addSubcommand((s) =>
    s.setName('zamien').setDescription('Swap the input and output channels (reverses the direction).')
  )
  .addSubcommand((s) => s.setName('stop').setDescription('Stop the voice relay.'))
  .addSubcommand((s) => s.setName('status').setDescription('Show whether the relay is running.'));

const reply = (content) => ({ content, flags: MessageFlags.Ephemeral });

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const guildId = interaction.guildId;
  if (!(await isModuleEnabled(guildId, 'voice-relay')))
    return interaction.reply(reply('Moduł Relay głosowy nie jest włączony na tym serwerze.'));
  const saved = normaliseVoiceRelay((await getGuildModule(guildId, 'voice-relay')).config);
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    const st = relayStatus(guildId);
    const embed = new EmbedBuilder()
      .setColor(st.running ? 0x57f287 : 0x99aab5)
      .setTitle('🔁 Relay głosowy')
      .setDescription(
        st.running
          ? `Działa ${st.twoWay ? 'dwukierunkowo' : 'jednokierunkowo'}.\nWejście: <#${st.inputChannelId}>\nWyjście: <#${st.outputChannelId}>\nMówi teraz: ${st.speakers}\nOd <t:${Math.floor(st.since / 1000)}:R>`
          : `Zatrzymany.${relayBotConfigured() ? '' : '\n⚠️ Brak drugiego bota (RELAY_BOT_TOKEN).'}${
              runtime.relayClient?.guilds.cache.has(guildId) || !relayBotConfigured()
                ? ''
                : `\n⚠️ Bot relay nie jest na tym serwerze.${relayInviteUrl() ? ` [Zaproś go](${relayInviteUrl()})` : ''}`
            }`
      );
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'stop') {
    await setGuildModule(guildId, 'voice-relay', { config: { ...saved, active: false } });
    await reconcileGuild(guildId);
    return interaction.reply(reply('🔇 Relay zatrzymany.'));
  }

  if (sub === 'zamien') {
    if (!saved.inputChannelId || !saved.outputChannelId)
      return interaction.reply(reply('Najpierw ustaw kanał wejściowy i wyjściowy.'));
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const swapped = {
      ...saved,
      inputChannelId: saved.outputChannelId,
      outputChannelId: saved.inputChannelId,
    };
    await setGuildModule(guildId, 'voice-relay', { config: swapped });
    if (!swapped.active)
      return interaction.editReply(
        `⇅ Zamieniono: wejście <#${swapped.inputChannelId}>, wyjście <#${swapped.outputChannelId}>. Relay jest zatrzymany.`
      );
    const error = await reconcileGuild(guildId, { startIfNeeded: true });
    return interaction.editReply(
      error
        ? `⚠️ ${error}`
        : `⇅ Zamieniono: wejście <#${swapped.inputChannelId}>, wyjście <#${swapped.outputChannelId}>.`
    );
  }

  // start
  const input = interaction.options.getChannel('wejscie')?.id ?? saved.inputChannelId;
  const output = interaction.options.getChannel('wyjscie')?.id ?? saved.outputChannelId;
  const twoWay = interaction.options.getBoolean('dwukierunkowo') ?? saved.twoWay;
  if (!input || !output)
    return interaction.reply(reply('Podaj kanał wejściowy i wyjściowy (albo zapisz je w panelu).'));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await setGuildModule(guildId, 'voice-relay', {
    config: { ...saved, inputChannelId: input, outputChannelId: output, twoWay, active: true },
  });
  try {
    const error = await reconcileGuild(guildId, { startIfNeeded: true });
    if (error) throw new RelayError(error);
    return interaction.editReply(`🔁 Relay uruchomiony: <#${input}> ${twoWay ? '⇄' : '→'} <#${output}>.`);
  } catch (err) {
    await setGuildModule(guildId, 'voice-relay', {
      config: { ...saved, inputChannelId: input, outputChannelId: output, twoWay, active: false },
    });
    return interaction.editReply(`⚠️ ${err.message}`);
  }
}
