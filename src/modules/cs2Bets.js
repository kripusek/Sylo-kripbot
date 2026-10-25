// "/gry cs2": stake coins on winning your own next CS2 match. The stake is taken
// at once; once Leetify reports the member's next match the stake pays 2x on a
// win, nothing on a loss, and comes back on a tie. The Steam account must have
// been linked with /steam polacz (Steam sign-in), so nobody can bet on another
// person's matches.
import { log } from '../lib/log.js';
import { runtime } from '../runtime.js';
import { ensureAccount, credit, debit } from '../db/economy.js';
import { getSteamLink, insertCs2Bet, pendingCs2Bets, pendingCs2BetOf, settleCs2Bet } from '../db/cs2.js';
import {
  firstMatchAfter,
  CS2_MODES,
  modeInfo,
  describeModeFields,
  parseLeetifyMatchId,
  matchById,
  describeMatch,
  detectMode,
} from './lib/cs2.js';
import { leetifyConfigured, leetifyMatches, leetifyMatchById } from './markets.js';
import { getGuildModule } from '../db/modules.js';
import { normaliseEconomy, formatCoins } from './economy.js';

export { CS2_MODES };
/** A match must finish this long after the stake, so a game already on its last rounds can't be bet on. */
export const MIN_MATCH_GAP_MS = 25 * 60_000;
/** Wingman and Rush games are short, so the stake only needs a shorter head start. */
const MODE_GAP_MS = { wingman: 10 * 60_000, rush: 7 * 60_000 };
export const matchGapMs = (mode) => MODE_GAP_MS[mode] ?? MIN_MATCH_GAP_MS;
/** Stakes with no usable match after this long are refunded. */
export const EXPIRY_MS = 72 * 3_600_000;
const SYNC_MS = 5 * 60_000;

/**
 * Take the stake and open it.
 * @returns {Promise<{ ok: true, balance: number, economy: object } | { ok: false, error: string }>}
 */
export async function placeCs2Bet(guildId, userId, amount, mode) {
  if (!CS2_MODES[mode])
    return { ok: false, error: 'Wybierz tryb gry: Rush, Wingman, Competitive albo Premier.' };
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
    id = await insertCs2Bet(guildId, userId, steamId, amount, mode);
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

/** Pay out (or take, or refund) a stake from a clear match result. */
async function applyResult(bet, found, coins) {
  const multiplier = modeInfo(bet.mode).multiplier;
  const win = Math.floor(bet.amount * multiplier);
  const info = `${found.map || 'CS2'}${found.score ? ` ${found.score}` : ''} — dane: Leetify`;
  if (found.state === 'win')
    return finish(bet, 'won', win, `🏆 Wygrałeś mecz CS2 (${info})! Wypłata ×${multiplier}: ${coins(win)}.`);
  if (found.state === 'loss')
    return finish(bet, 'lost', 0, `💀 Przegrałeś mecz CS2 (${info}). Stawka ${coins(bet.amount)} przepadła.`);
  return finish(
    bet,
    'tie',
    bet.amount,
    `🤝 Remis w meczu CS2 (${info}) — stawka ${coins(bet.amount)} wróciła na konto.`
  );
}

/**
 * Settle your own stake from a Leetify match link — for matches the automatic
 * check can't see or classify. The match must be yours, finish late enough, fit
 * the stake's mode, and no earlier counting match of yours may exist.
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function claimCs2ByLink(guildId, userId, link) {
  const id = parseLeetifyMatchId(link);
  if (!id) return { ok: false, message: 'Podaj link do meczu z Leetify (leetify.com/app/match-details/…).' };
  const bet = await pendingCs2BetOf(guildId, userId);
  if (!bet) return { ok: false, message: 'Nie masz aktywnej stawki CS2.' };
  if (!leetifyConfigured()) return { ok: false, message: 'Brak klucza Leetify na serwerze bota.' };
  let matches;
  let raw;
  try {
    matches = await leetifyMatches(bet.steamId);
    raw = matchById(matches, id) ?? (await leetifyMatchById(id));
  } catch (error) {
    return { ok: false, message: error.message ?? String(error) };
  }
  if (!raw) return { ok: false, message: 'Leetify nie zna tego meczu — poczekaj, aż się przetworzy.' };
  const found = describeMatch(raw, bet.steamId);
  if (found.state === 'unclear' && !found.score)
    return {
      ok: false,
      message:
        'Nie widzę Cię w tym meczu albo Leetify nie podaje wyniku — to musi być mecz z Twojego połączonego konta Steam.',
    };
  if (found.finishedAt === null || found.finishedAt <= bet.createdAt + matchGapMs(bet.mode))
    return {
      ok: false,
      message: `Mecz musi skończyć się co najmniej ${matchGapMs(bet.mode) / 60_000} min po postawieniu stawki.`,
    };
  if (CS2_MODES[bet.mode] && found.mode && found.mode !== bet.mode)
    return {
      ok: false,
      message: `To mecz ${CS2_MODES[found.mode].label}, a stawka jest na ${CS2_MODES[bet.mode].label}.`,
    };
  const earlier = matches.filter((m) => {
    const other = describeMatch(m, bet.steamId);
    return (
      other.id !== found.id &&
      other.finishedAt !== null &&
      other.finishedAt > bet.createdAt + matchGapMs(bet.mode) &&
      other.finishedAt < found.finishedAt &&
      (!CS2_MODES[bet.mode] || detectMode(m) === bet.mode)
    );
  });
  if (earlier.length)
    return {
      ok: false,
      message: 'Liczy się pierwszy mecz po stawce — wcześniej skończyłeś inny mecz tego trybu.',
    };
  if (found.state === 'unclear')
    return { ok: false, message: 'Wynik tego meczu jest niejasny w danych Leetify.' };
  const economy = normaliseEconomy((await getGuildModule(guildId, 'economy')).config);
  const coins = (n) => formatCoins(economy, n).replaceAll('**', '');
  const done = await applyResult(bet, found, coins);
  return done
    ? { ok: true, message: 'Stawka rozliczona — szczegóły przyszły w DM.' }
    : { ok: false, message: 'Ta stawka została już rozliczona.' };
}

/** Admin help: what Leetify returns for a player and what the bot makes of it. */
export async function debugCs2(guildId, userId, limit = 5) {
  const bet = await pendingCs2BetOf(guildId, userId);
  const steamId = bet?.steamId ?? (await getSteamLink(guildId, userId));
  if (!steamId) return 'Brak połączonego Steama.';
  const matches = (await leetifyMatches(steamId)).slice(0, limit);
  const lines = matches.map((m) => {
    const d = describeMatch(m, steamId);
    const at = d.finishedAt ? new Date(d.finishedAt).toISOString().slice(0, 16).replace('T', ' ') : '?';
    return `• ${at} UTC · ${d.map || '?'} · ${d.score || '?'} · ${d.state} · tryb: ${d.mode ?? 'nieznany'} [${describeModeFields(m)}]\n  id: ${d.id}`;
  });
  const head = bet
    ? `Aktywna stawka: ${bet.amount} na ${CS2_MODES[bet.mode]?.label ?? 'dowolny'}, postawiona ${new Date(bet.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC (liczą się mecze zakończone po +${matchGapMs(bet.mode) / 60_000} min).`
    : 'Brak aktywnej stawki.';
  return [head, ...(lines.length ? lines : ['Leetify nie zwrócił żadnych meczów.'])]
    .join('\n')
    .slice(0, 1900);
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
      const wanted = CS2_MODES[bet.mode] ? bet.mode : null;
      let found = firstMatchAfter(matches, steamId, bet.createdAt + matchGapMs(bet.mode), wanted);
      if (found?.none) {
        log.warn(
          'module:cs2-bets',
          `bet ${bet.id} (${bet.mode}): ${found.skippedUnknown} match(es) skipped because Leetify doesn't say their mode — e.g. ${describeModeFields(matches[0])}`
        );
        found = null;
      }
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
      await applyResult(bet, found, coins);
    }
  }
}

const timer = setInterval(() => {
  syncCs2Bets().catch((error) => log.error('module:cs2-bets', 'sync failed:', error.message ?? error));
}, SYNC_MS);
timer.unref();
