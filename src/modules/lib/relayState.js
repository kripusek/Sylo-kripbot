// Which guilds currently have a voice relay running. Music and the soundboard
// check this so they never try to use a voice channel the relay already holds.
const active = new Set();

export const relayActive = (guildId) => active.has(guildId);
export function markRelay(guildId, on) {
  if (on) active.add(guildId);
  else active.delete(guildId);
}
