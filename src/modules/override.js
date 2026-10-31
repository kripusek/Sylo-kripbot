// Break-glass access for the bot's operator. `OVERRIDE_ID` in the environment
// names the Discord account(s) allowed to run `/override`; the command gives
// that account an "Sylo Override" role — with Administrator when the bot itself
// holds it, and always as a dashboard "bot master" role — so an operator whose
// admin rights were taken away can get back in. Every use is written to the
// guild's audit log. `OVERRIDE_GUILD_IDS` (optional) limits it to those servers.
import { PermissionFlagsBits } from 'discord.js';
import { getBotMasterRoles, setBotMasterRoles } from '../db/guildSettings.js';
import { recordAudit } from '../db/audit.js';
import { log } from '../lib/log.js';

export const OVERRIDE_ROLE_NAME = 'Sylo Override';
const ids = (raw) =>
  String(raw ?? '')
    .split(/[\s,]+/)
    .filter((id) => /^\d{17,20}$/.test(id));

// Read at call time so a changed .env only needs a restart, and tests can set it.
export const overrideIds = () => ids(process.env.OVERRIDE_ID);
export const isOverrideUser = (userId) => overrideIds().includes(String(userId));
export function overrideAllowedIn(guildId) {
  const only = ids(process.env.OVERRIDE_GUILD_IDS);
  return only.length === 0 || only.includes(String(guildId));
}

/**
 * Give `userId` the override role in `guild`.
 * @returns {Promise<{ ok: true, role: object, administrator: boolean } | { ok: false, error: string }>}
 */
export async function grantOverride(guild, userId) {
  if (!isOverrideUser(userId)) return { ok: false, error: 'Brak uprawnień.' };
  if (!overrideAllowedIn(guild.id))
    return { ok: false, error: 'Override nie jest włączony na tym serwerze.' };
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles))
    return { ok: false, error: 'Bot nie ma uprawnienia „Zarządzanie rolami” na tym serwerze.' };

  const administrator = me.permissions.has(PermissionFlagsBits.Administrator);
  try {
    let role = guild.roles.cache.find((r) => r.name === OVERRIDE_ROLE_NAME && !r.managed);
    if (!role) {
      role = await guild.roles.create({
        name: OVERRIDE_ROLE_NAME,
        permissions: administrator ? [PermissionFlagsBits.Administrator] : [],
        position: Math.max(1, me.roles.highest.position - 1),
        reason: `/override by ${userId}`,
      });
    } else if (role.comparePositionTo(me.roles.highest) >= 0) {
      return {
        ok: false,
        error: `Rola „${OVERRIDE_ROLE_NAME}” jest wyżej niż rola bota — przesuń ją niżej.`,
      };
    }
    const member = await guild.members.fetch(userId);
    await member.roles.add(role, `/override by ${userId}`);
    const masters = await getBotMasterRoles(guild.id);
    if (!masters.includes(role.id)) await setBotMasterRoles(guild.id, [...masters, role.id]);
    await recordAudit(guild.id, {
      actor: userId,
      action: 'override',
      detail: `Granted role ${role.id}${administrator ? ' (Administrator)' : ' (dashboard only)'}`,
    });
    log.warn('override', `${userId} used /override in ${guild.id}`);
    return { ok: true, role, administrator };
  } catch (error) {
    log.warn('override', `failed in ${guild.id}: ${error.message ?? error}`);
    return { ok: false, error: `Nie udało się: ${error.message ?? error}` };
  }
}
