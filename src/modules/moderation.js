// Moderation module. Unlike the event-driven modules, its logic is invoked
// directly from the warning flow (slash command + dashboard).
//
// config shape:
//   {
//     dmOnPunish: boolean,
//     warnThresholds: [ { count, action: 'timeout'|'kick'|'ban', durationMinutes? } ]
//   }
import { EmbedBuilder } from 'discord.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { dueTempBans, clearTempBan, scheduleTempBan, getTempBan } from '../db/tempBans.js';
import { addCase, deactivateLatest } from '../db/modCases.js';
import { postModLog } from '../bot/lib/modlog.js';
import { notifyTarget, MOD_COLOR, INFO_COLOR } from '../bot/lib/moderation.js';
import { formatDuration } from '../bot/lib/duration.js';
import { sendPreBanAppealDm } from './appeals.js';
import { log } from '../lib/log.js';

export const THRESHOLD_ACTIONS = ['timeout', 'kick', 'ban'];
export const DEFAULT_WARN_THRESHOLDS = [
  { count: 3, action: 'ban', durationMinutes: 43_200 },
  { count: 5, action: 'ban', durationMinutes: 0 },
];
const targetLocks = new Map();
async function withTargetLock(key, action) {
  const previous = targetLocks.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(action);
  targetLocks.set(key, pending);
  try {
    return await pending;
  } finally {
    if (targetLocks.get(key) === pending) targetLocks.delete(key);
  }
}
const MAX_TIMEOUT_MS = 28 * 86_400_000;

/** Normalise a stored threshold list: drop invalid rows, sort by count. */
export function normaliseThresholds(list) {
  return (Array.isArray(list) && list.length ? list : DEFAULT_WARN_THRESHOLDS)
    .filter((r) => r && Number.isFinite(Number(r.count)) && Number(r.count) >= 1)
    .map((r) => ({
      count: Math.max(1, Math.min(100, Math.floor(Number(r.count)))),
      action: THRESHOLD_ACTIONS.includes(r.action) ? r.action : 'timeout',
      durationMinutes:
        r.action === 'ban'
          ? Math.max(0, Math.min(525_600, Math.floor(Number(r.durationMinutes) || 0)))
          : Math.max(1, Math.min(40_320, Math.floor(Number(r.durationMinutes) || 60))),
    }))
    .sort((a, b) => a.count - b.count);
}

/**
 * After a warning is issued, apply the strictest matching threshold rule.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} targetUser
 * @param {number} warnCount  the user's new total warning count
 * @param {string} moderatorLabel  who issued the warning (for the mod-log)
 */
export async function applyWarnThresholds(guild, targetUser, warnCount, moderatorLabel) {
  return withTargetLock(`${guild.id}:${targetUser.id}`, () =>
    applyThreshold(guild, targetUser, warnCount, moderatorLabel)
  );
}

async function applyThreshold(guild, targetUser, warnCount, moderatorLabel) {
  if (!(await isModuleEnabled(guild.id, 'moderation'))) return;
  const config = (await getGuildModule(guild.id, 'moderation')).config;
  const rules = normaliseThresholds(config.warnThresholds);

  // Strictest rule whose count the user has reached (exact or exceeded).
  const rule = [...rules].reverse().find((r) => warnCount >= r.count);
  if (!rule) return;

  const member = await guild.members.fetch(targetUser.id).catch(() => null);
  // Immunity roles (shared with Auto-moderation) are never auto-punished.
  const immune = (await getGuildModule(guild.id, 'automod')).config.exemptRoles;
  if (member && Array.isArray(immune) && immune.some((r) => member.roles.cache.has(r))) return;
  const reason = `Automatyczna kara: ${warnCount} warnów (próg: ${rule.count}).`;
  let unbanAt = null;
  let done = null;

  try {
    if (rule.action === 'timeout' && member?.moderatable) {
      await member.timeout(Math.min(rule.durationMinutes * 60_000, MAX_TIMEOUT_MS), reason);
      done = `timed out for ${rule.durationMinutes}m`;
    } else if (rule.action === 'kick' && member?.kickable) {
      if (config.dmOnPunish !== false) {
        await notifyTarget(targetUser, { guildName: guild.name, action: 'kicked', reason });
      }
      await member.kick(reason);
      done = 'kicked';
    } else if (rule.action === 'ban' && guild.members.me?.permissions.has('BanMembers')) {
      if (member && !member.bannable) return;
      const scheduled = await getTempBan(guild.id, targetUser.id);
      if (rule.durationMinutes > 0 && scheduled) return; // Do not extend the ban for warning #4.
      if (config.dmOnPunish !== false) {
        // DM before the ban; the appeals module adds the appeal link when active.
        const appeal = await sendPreBanAppealDm(guild, targetUser, reason);
        if (appeal === null) {
          await notifyTarget(targetUser, {
            guildName: guild.name,
            action: 'banned',
            reason,
            extra:
              rule.durationMinutes > 0
                ? `Ban na ${formatDuration(rule.durationMinutes * 60_000)}.`
                : 'Ban permanentny.',
          });
        }
      }
      await guild.bans.create(targetUser.id, { reason });
      if (rule.durationMinutes > 0) {
        unbanAt = Date.now() + rule.durationMinutes * 60_000;
        await scheduleTempBan({ guildId: guild.id, userId: targetUser.id, modId: 'auto', reason, unbanAt });
        done = `Ban na ${formatDuration(rule.durationMinutes * 60_000)}`;
      } else {
        await clearTempBan(guild.id, targetUser.id);
        done = 'Ban permanentny';
      }
    }
  } catch (err) {
    log.error('module:moderation', 'auto-action failed:', err.message);
    return;
  }
  if (!done) return;

  const caseAction = done.startsWith('timed out') ? 'timeout' : rule.action;
  const { caseNumber } = await addCase({
    guildId: guild.id,
    userId: targetUser.id,
    moderatorId: 'auto',
    action: caseAction,
    reason,
    detail:
      caseAction === 'timeout'
        ? `${rule.durationMinutes}m`
        : caseAction === 'ban'
          ? unbanAt
            ? formatDuration(rule.durationMinutes * 60_000)
            : 'permanent'
          : null,
  });

  const embed = new EmbedBuilder()
    .setColor(MOD_COLOR)
    .setTitle('Automatyczna kara')
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name: 'Sprawa', value: `#${caseNumber}` },
      { name: 'Użytkownik', value: `${targetUser.tag} (\`${targetUser.id}\`)` },
      { name: 'Kara', value: done },
      { name: 'Powód', value: `Warn #${warnCount} · wystawił ${moderatorLabel}` }
    )
    .setTimestamp(Date.now());
  if (unbanAt) embed.addFields({ name: 'Odbanowanie', value: `<t:${Math.floor(unbanAt / 1000)}:F>` });
  await postModLog(guild, embed);
}

// --- temporary-ban expiry loop ------------------------------------------
// Mirrors the giveaways expiry loop: a slow tick that lifts bans whose
// `unban_at` has passed. /ban duration:… schedules the rows (src/db/tempBans.js).

const TEMP_BAN_TICK_MS = 30_000;

export async function settleTempBan(row) {
  return withTargetLock(`${row.guild_id}:${row.user_id}`, () => settleLocked(row));
}

async function settleLocked(row) {
  const current = await getTempBan(row.guild_id, row.user_id);
  if (!current || current.unban_at !== row.unban_at || current.unban_at > Date.now()) return;
  const guild = runtime.client?.guilds.cache.get(row.guild_id);
  if (!guild?.members.me?.permissions.has('BanMembers')) return;

  const existing = await guild.bans.fetch(row.user_id).catch((err) => {
    if (err.code === 10026) return null; // Discord: Unknown Ban
    throw err;
  });
  if (!existing) {
    await clearTempBan(row.guild_id, row.user_id);
    return;
  } // already unbanned (manually or by Discord)

  await guild.bans.remove(row.user_id, 'Temporary ban expired');
  await clearTempBan(row.guild_id, row.user_id);
  const clearedCase = await deactivateLatest(row.guild_id, row.user_id, 'ban');
  const { caseNumber } = await addCase({
    guildId: row.guild_id,
    userId: row.user_id,
    moderatorId: 'auto',
    action: 'unban',
    reason: 'Temporary ban expired',
  });
  const embed = new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle('Temporary ban expired')
    .addFields(
      { name: 'Case', value: clearedCase ? `#${caseNumber} (clears #${clearedCase})` : `#${caseNumber}` },
      { name: 'User', value: `<@${row.user_id}> (\`${row.user_id}\`)` },
      { name: 'Original reason', value: row.reason },
      { name: 'Ban length', value: formatDuration(row.unban_at - row.created_at) || 'unknown' }
    )
    .setTimestamp(Date.now());
  await postModLog(guild, embed);
}

let settling = false;
const tempBanTimer = setInterval(async () => {
  if (settling || !runtime.client?.isReady()) return;
  settling = true;
  try {
    for (const row of await dueTempBans(Date.now())) {
      await settleTempBan(row).catch((err) =>
        log.error('module:moderation', 'temp-unban failed:', err.message)
      );
    }
  } catch (err) {
    log.error('module:moderation', 'temp-ban scan failed:', err.message);
  } finally {
    settling = false;
  }
}, TEMP_BAN_TICK_MS);
tempBanTimer.unref();
