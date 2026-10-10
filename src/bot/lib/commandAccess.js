import { PermissionFlagsBits as P } from 'discord.js';

// These commands may be delegated to server roles through the dashboard.
export const moderationPermissions = Object.freeze({
  warn: P.ModerateMembers,
  ban: P.BanMembers,
  kick: P.KickMembers,
  timeout: P.ModerateMembers,
  untimeout: P.ModerateMembers,
  unban: P.BanMembers,
  case: P.ModerateMembers,
  history: P.ModerateMembers,
  purge: P.ManageMessages,
  lock: P.ManageChannels,
  unlock: P.ManageChannels,
  lockdown: P.ManageChannels,
  slowmode: P.ManageChannels,
});

export function commandDefinitionForRegistration(command) {
  const data = command.data.toJSON();
  // Discord's native permission gate cannot express our per-server role grants.
  // The interaction router enforces permissions before executing these commands.
  if (Object.hasOwn(moderationPermissions, data.name)) data.default_member_permissions = null;
  return data;
}
