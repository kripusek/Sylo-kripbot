import { AuditLogEvent, Events } from 'discord.js';
import { recordExternalPunishment } from '../../db/modCases.js';
import { log } from '../../lib/log.js';

export const name = Events.GuildAuditLogEntryCreate;

export async function execute(entry, guild) {
  try {
    // Sylo records its own actions separately, including automated actions.
    if (!entry.executorId || entry.executorId === guild.client.user.id || !entry.targetId) return;
    let action;
    if (entry.action === AuditLogEvent.MemberBanAdd) action = 'ban';
    else if (entry.action === AuditLogEvent.MemberKick) action = 'kick';
    else if (entry.action === AuditLogEvent.MemberUpdate) {
      const timeout = entry.changes?.find((change) => change.key === 'communication_disabled_until');
      if (!timeout?.new || new Date(timeout.new).getTime() <= Date.now()) return;
      action = 'timeout';
    } else return;
    await recordExternalPunishment({
      guildId: guild.id, auditId: entry.id, moderatorId: entry.executorId,
      userId: entry.targetId, action, reason: String(entry.reason || '').slice(0, 1000),
      createdAt: entry.createdTimestamp || Date.now(),
    });
  } catch (err) {
    log.error('audit-punishments', 'Failed to record Discord action:', err.message);
  }
}
