// User menu: right-click a member → Apps → "Wycisz / odcisz". Discord allows only 5 user
// menu commands per app, so one entry does both: a member who is timed out gets the
// timeout removed (/untimeout rules), anyone else gets the timeout form (/timeout rules).
import { MessageFlags } from 'discord.js';
import { userMenu, modalMenu, reasonInput, durationInput } from '../lib/contextMenus.js';
import { overrideBlockReason } from '../events/interactionCreate.js';
import { NO_REASON } from '../lib/moderation.js';
import { applyTimeout } from './timeout.js';
import { applyUntimeout } from './untimeout.js';

const NAME = 'Wycisz / odcisz';
export const data = userMenu(NAME);

const showForm = modalMenu({
  commandName: NAME,
  prefix: 'ctxmute:',
  title: 'Wycisz',
  fields: [durationInput(true), reasonInput()],
  run: (interaction, { member, reason, text }) => applyTimeout(interaction, member, reason, text('duration')),
});

export async function execute(interaction) {
  const member = await interaction.guild.members.fetch(interaction.targetUser.id).catch(() => null);
  if (!member?.isCommunicationDisabled()) return showForm(interaction);
  const blocked = await overrideBlockReason({
    commandName: 'untimeout',
    inGuild: () => interaction.inGuild(),
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    member: interaction.member,
    memberPermissions: interaction.memberPermissions,
  });
  if (blocked) return interaction.reply({ content: `⚠️ ${blocked}`, flags: MessageFlags.Ephemeral });
  return applyUntimeout(interaction, member, NO_REASON);
}
