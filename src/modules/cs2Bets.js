// "/gry cs2": stake coins on winning your own next CS2 match. The stake is taken
// at once; once Leetify reports the member's next match the stake pays 2x on a
// win, nothing on a loss, and comes back on a tie. The Steam account must have
// been linked with /steam polacz (Steam sign-in), so nobody can bet on another
// person's matches.
import { log } from '../lib/log.js';
import { runtime } from '../runtime.js';
import { ensureAccount, credit, debit } from '../db/economy.js';
import { getSteamLink, insertCs2Bet, pendingCs2Bets, settleCs2Bet } from '../db/cs2.js';
import { firstMatchAfter } from './lib/cs2.js';
import { leetifyConfigured, leetifyMatches } from './markets.js';
import { getGuildModule } from '../db/modules.js';
import { normaliseEconomy, formatCoins } from './economy.js';

export const CS2_WIN_MULTIPLIER = 2;
/** A match must finish this long after the stake, so a game already on its last rounds can't be bet on. */
export const MIN_MATCH_GAP_MS = 25 * 60_000;
/** Stakes with no usable match after this long are refunded. */
export const EXPIRY_MS = 72 * 3_600_000;
const SYNC_MS = 5 * 60_000;

/**
 * Take the stake and open it.
 * @returns {Promise<{ ok: true, balance: number, economy: object } | { ok: false, error: string }>}
 */
export async function placeCs2Bet(guildId, userId, amount) {
  const economy = normaliseEconomy((await getGuildModule(guildId, 'economy')).config);
  if (!(await getGuildModule(guildId, 'economy')).enabled)
    return { ok: false, error: 'Moduł Ekonomia nie jest włączony na tym serwerze.' };
  if (!economy.games.enabled) return { ok: false, error: 'Gry są wyłączone na tym serwerze.' };
  if (!leetifyConfigured())
    return { ok: false, error: 'Zakłady CS2 nie są skonfigurowane (brak klucza Leetify na serwerze bota).' };
  const steamId = await getSteamLink(guildId, userId);
  if (!steamId) return { ok: false, error: 'Najpierw połącz konto Steam: użyj **/steam polacz**.' };
  if (!Number.isInteger(amount) || amount < economy.games.minBet || amount > economy.games.maxBet)
    return {
      ok: false,
      error: `Stawka musi być od ${economy.games.minBet} do ${economy.games.maxBet} monet.`,
    };

  await ensureAccount(guildId, userId, economy.startingBalance);
  const balance = await debit(guildId, userId, amount);
  if (balance === null) return { ok: false, error: 'Nie masz tylu monet.' };
  let id;
  try {
    id = await insertCs2Bet(guildId, userId, steamId, amount);
  } catch (error) {
    await credit(guildId, userId, amount);
    throw error;
  }
  if (id === null) {
    await credit(guildId, userId, amount);
    return { ok: false, error: 'Masz już aktywną stawkę CS2 — poczekaj na wynik meczu.' };
  }
  return { ok: true, balance, economy, id };
}

async function tell(bet, text) {
  try {
    const user = await runtime.client?.users.fetch(bet.userId);
    await user?.send({ content: text, allowedMentions: { parse: [] } });
  } catch {
    // DMs closed — the result is still on their balance.
  }
}

async function finish(bet, status, payout, text) {
  if (!(await settleCs2Bet(bet.id, status, payout))) return false; // somebody else settled it
  if (payout > 0) await credit(bet.guildId, bet.userId, payout);
  await tell(bet, text);
  return true;
}

/** Settle every pending stake whose player has finished a counting match. */
export async function syncCs2Bets(now = Date.now()) {
  if (!leetifyConfigured()) return;
  const pending = await pendingCs2Bets();
  const bySteam = new Map();
  for (const bet of pending) bySteam.set(bet.steamId, [...(bySteam.get(bet.steamId) ?? []), bet]);
  for (const [steamId, bets] of bySteam) {
    let matches;
    try {
      matches = await leetifyMatches(steamId);
    } catch (error) {
      log.warn('module:cs2-bets', `Leetify sync for ${steamId} failed:`, error.message ?? error);
      continue;
    }
    for (const bet of bets) {
      const economy = normaliseEconomy((await getGuildModule(bet.guildId, 'economy')).config);
      const coins = (n) => formatCoins(economy, n).replaceAll('**', '');
      const found = firstMatchAfter(matches, steamId, bet.createdAt + MIN_MATCH_GAP_MS);
      const info = found
        ? `${found.map || 'CS2'}${found.score ? ` ${found.score}` : ''} — dane: Leetify`
        : '';
      if (!found || found.state === 'unclear') {
        if (now - bet.createdAt > EXPIRY_MS)
          await finish(
            bet,
            'expired',
            bet.amount,
            `⏳ Nie znalazłem Twojego meczu CS2, stawka ${coins(bet.amount)} wróciła na konto.`
          );
        else if (found) log.warn('module:cs2-bets', `bet ${bet.id}: match ${found.id} has no clear result`);
        continue;
      }
      if (found.state === 'win')
        await finish(
          bet,
          'won',
          bet.amount * CS2_WIN_MULTIPLIER,
          `🏆 Wygrałeś mecz CS2 (${info})! Wypłata: ${coins(bet.amount * CS2_WIN_MULTIPLIER)}.`
        );
      else if (found.state === 'loss')
        await finish(
          bet,
          'lost',
          0,
          `💀 Przegrałeś mecz CS2 (${info}). Stawka ${coins(bet.amount)} przepadła.`
        );
      else
        await finish(
          bet,
          'tie',
          bet.amount,
          `🤝 Remis w meczu CS2 (${info}) — stawka ${coins(bet.amount)} wróciła na konto.`
        );
    }
  }
}

const timer = setInterval(() => {
  syncCs2Bets().catch((error) => log.error('module:cs2-bets', 'sync failed:', error.message ?? error));
}, SYNC_MS);
timer.unref();
