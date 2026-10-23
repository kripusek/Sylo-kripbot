// Prediction markets ("Rynki"): members bet virtual economy coins on the outcome
// of a question. Markets are either created by hand in the dashboard or imported
// from Polymarket (public read-only data; no real money is involved anywhere).
// The pool is split between the winners in proportion to their stake.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { registerComponent } from '../bot/lib/components.js';
import { log } from '../lib/log.js';
import { runtime } from '../runtime.js';
import { getGuildModule } from '../db/modules.js';
import { ensureAccount, credit, debit } from '../db/economy.js';
import {
  insertMarket,
  getMarket,
  getGuildMarket,
  listMarkets,
  openPolymarketMarkets,
  openMarketsBySource,
  setMarketOptions,
  setMarketMessage,
  markResolved,
  markCancelled,
  deleteMarket,
  recordBet,
  optionPools,
  betsOfMarket,
  userStakes,
  claimPayout,
} from '../db/markets.js';
import { normaliseEconomy, formatCoins, coinsText, MAX_PAYOUT } from './economy.js';
import { postToChannel, deleteChannelMessage } from './lib/send.js';
import {
  computePayouts,
  refundAll,
  describePools,
  normaliseMarketInput,
  parsePolymarketSlug,
  evaluatePolymarketEvent,
  OPTIONS_MAX,
} from './lib/marketMath.js';
import { parseSteam64, matchList, firstMatchAfter } from './lib/cs2.js';

export { normaliseMarketInput, parsePolymarketSlug, OPTIONS_MAX };

const COLORS = { open: 0x5b7cfa, resolved: 0x57f287, cancelled: 0x99aab5 };
const BET_PREFIX = 'mkt:b:';
const MODAL_PREFIX = 'mkt:m:';
const GAMMA = 'https://gamma-api.polymarket.com';
const POLYMARKET_TIMEOUT_MS = 10_000;
const SYNC_MS = 5 * 60_000;
const MAX_OPEN_MARKETS = 25;

/** Settings stored in the module config. */
export function normaliseMarkets(raw = {}) {
  const int = (v, min, max, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  const minBet = int(raw.minBet, 1, MAX_PAYOUT, 10);
  return {
    minBet,
    maxBet: int(raw.maxBet, minBet, MAX_PAYOUT, Math.max(5000, minBet)),
    channelId: /^\d{17,20}$/.test(raw.channelId ?? '') ? raw.channelId : '',
  };
}

async function loadSettings(guildId) {
  const [markets, economy] = await Promise.all([
    getGuildModule(guildId, 'markets'),
    getGuildModule(guildId, 'economy'),
  ]);
  return {
    enabled: markets.enabled && economy.enabled,
    marketsEnabled: markets.enabled,
    economyEnabled: economy.enabled,
    config: normaliseMarkets(markets.config),
    economy: normaliseEconomy(economy.config),
  };
}

// ------------------------------------------------------------- Polymarket ----

async function gammaGet(path) {
  const res = await fetch(`${GAMMA}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(POLYMARKET_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Polymarket odpowiedział ${res.status}.`);
  return res.json();
}

/** Gamma returns a bare array from /events and `{ events, next_cursor }` from /events/keyset. */
const eventList = (body) => (Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : []);

/** Try each path in turn and return the first list that loads; the last error is kept for the message. */
async function gammaEvents(paths) {
  let failure;
  for (const path of paths) {
    try {
      return eventList(await gammaGet(path));
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

/** Fetch one Polymarket event by slug. Throws a Polish message when it can't be read. */
export async function fetchPolymarketEvent(slug) {
  let event;
  try {
    const q = encodeURIComponent(slug);
    event = (await gammaEvents([`/events?slug=${q}`, `/events/keyset?slug=${q}&closed=any`]))[0];
    if (!event) {
      const markets = await gammaGet(`/markets?slug=${encodeURIComponent(slug)}`);
      if (Array.isArray(markets) && markets[0])
        event = { title: markets[0].question, description: markets[0].description, markets: [markets[0]] };
    }
  } catch (error) {
    throw new Error(`Nie udało się pobrać rynku z Polymarketa (${error.message ?? error}).`, {
      cause: error,
    });
  }
  const evaluated = evaluatePolymarketEvent(event);
  if (!evaluated)
    throw new Error('Nie znalazłem takiego rynku na Polymarkecie albo ma nieobsługiwany układ opcji.');
  return evaluated;
}

/** The most-traded open Polymarket events, for the "pick one" list in the dashboard. */
export async function trendingPolymarket(limit = 20) {
  const n = Math.min(50, limit);
  const events = await gammaEvents([
    `/events/keyset?closed=false&order=volume24hr&ascending=false&limit=${n}`,
    `/events?closed=false&order=volume24hr&ascending=false&limit=${n}`,
    `/events/keyset?closed=false&limit=${n}`,
  ]).catch((error) => {
    throw new Error(`Nie udało się pobrać listy z Polymarketa (${error.message ?? error}).`, {
      cause: error,
    });
  });
  return events
    .map((event) => ({ slug: String(event.slug ?? ''), evaluated: evaluatePolymarketEvent(event) }))
    .filter((e) => e.slug && e.evaluated && e.evaluated.state === 'open')
    .map((e) => ({
      slug: e.slug,
      question: e.evaluated.question,
      options: e.evaluated.options.map((o) => ({
        label: o.label,
        percent: o.price === null ? null : Math.round(o.price * 100),
      })),
    }));
}

/**
 * Create a market from a Polymarket event (URL or slug).
 * @returns {Promise<number>} the new market id
 */
export async function importPolymarket(guildId, input) {
  const slug = parsePolymarketSlug(input);
  if (!slug) throw new Error('Wklej adres rynku z polymarket.com (albo sam identyfikator z adresu).');
  if (await tooManyOpen(guildId)) throw new Error(`Maksymalnie ${MAX_OPEN_MARKETS} otwartych rynków naraz.`);
  const open = await listMarkets(guildId, { openOnly: true });
  if (open.some((m) => m.source === 'polymarket' && m.sourceRef === slug))
    throw new Error('Ten rynek z Polymarketa jest już otwarty na serwerze.');
  const event = await fetchPolymarketEvent(slug);
  if (event.state !== 'open') throw new Error('Ten rynek jest już rozstrzygnięty na Polymarkecie.');
  const id = await insertMarket(guildId, {
    question: event.question,
    description: event.description,
    source: 'polymarket',
    sourceRef: slug,
    options: event.options,
    closesAt: event.closesAt > Date.now() ? event.closesAt : 0,
  });
  return id;
}

async function tooManyOpen(guildId) {
  return (await listMarkets(guildId, { openOnly: true })).length >= MAX_OPEN_MARKETS;
}

// ------------------------------------------------------------------ CS2 ----

const LEETIFY = 'https://api-public.cs-prod.leetify.com';
// Read at call time so the key can be added without touching config loading.
const leetifyKey = () => process.env.LEETIFY_API_KEY ?? '';
export const leetifyConfigured = () => Boolean(leetifyKey());

async function leetifyMatches(steamId) {
  const res = await fetch(`${LEETIFY}/v3/profile/matches?steamId=${steamId}&limit=20`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${leetifyKey()}`,
      _leetify_key: leetifyKey(),
    },
    signal: AbortSignal.timeout(POLYMARKET_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403)
    throw new Error('Leetify odrzucił klucz API (LEETIFY_API_KEY).');
  if (res.status === 404)
    throw new Error('Leetify nie zna tego SteamID (profil musi istnieć na leetify.com).');
  if (!res.ok) throw new Error(`Leetify odpowiedział ${res.status}.`);
  return matchList(await res.json());
}

/**
 * "Will <player> win their next CS2 match?" — settled from Leetify. The match that
 * counts is the first one the player finishes after `closesAt` (or after creation).
 */
export async function createCs2Market(guildId, raw) {
  const steamId = parseSteam64(raw.steamId);
  if (!steamId)
    throw new Error(
      'Podaj SteamID64 (17 cyfr, zaczyna się od 7656119) albo link steamcommunity.com/profiles/….'
    );
  if (await tooManyOpen(guildId)) throw new Error(`Maksymalnie ${MAX_OPEN_MARKETS} otwartych rynków naraz.`);
  if (leetifyConfigured()) {
    try {
      await leetifyMatches(steamId); // fail now rather than leave a market that can never settle itself
    } catch (error) {
      throw new Error(error.message ?? String(error), { cause: error });
    }
  }
  const name =
    String(raw.name ?? '')
      .trim()
      .slice(0, 40) || 'Gracz';
  const parsed = normaliseMarketInput({
    question: `Czy ${name} wygra następny mecz CS2?`,
    description:
      String(raw.description ?? '').trim() ||
      'Liczy się pierwszy mecz zakończony po zamknięciu zakładów. Remis = zwrot stawek.',
    options: ['Wygra', 'Przegra'],
    closesAt: raw.closesAt,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return insertMarket(guildId, { ...parsed.value, source: 'cs2', sourceRef: steamId });
}

/** Settle open CS2 markets whose player has finished a match since betting closed. */
export async function syncCs2() {
  if (!leetifyConfigured()) return;
  const open = (await openMarketsBySource('cs2')).filter((m) => !m.closesAt || m.closesAt <= Date.now() + 1);
  const bySteam = new Map();
  for (const market of open)
    bySteam.set(market.sourceRef, [...(bySteam.get(market.sourceRef) ?? []), market]);
  for (const [steamId, markets] of bySteam) {
    let matches;
    try {
      matches = await leetifyMatches(steamId);
    } catch (error) {
      log.warn('module:markets', `Leetify sync for ${steamId} failed:`, error.message ?? error);
      continue;
    }
    for (const market of markets) {
      const found = firstMatchAfter(matches, steamId, market.closesAt || market.createdAt);
      if (!found) continue;
      if (found.state === 'unclear') {
        log.warn(
          'module:markets',
          `market ${market.id}: match ${found.id} has no clear result, left for manual settling`
        );
        continue;
      }
      const note = `Mecz: ${found.map || 'CS2'}${found.score ? ` ${found.score}` : ''} — dane: Leetify`;
      const done =
        found.state === 'tie'
          ? await cancelMarket(market.guildId, market.id, `Remis w meczu (${note}) — zakłady zwrócone.`)
          : await settleMarket(market.guildId, market.id, found.state === 'win' ? 0 : 1, note);
      if (!done.ok) log.warn('module:markets', `market ${market.id} not settled: ${done.error}`);
    }
  }
}

/** Create a hand-made market from dashboard input. */
export async function createCustomMarket(guildId, raw) {
  const parsed = normaliseMarketInput(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  if (await tooManyOpen(guildId)) throw new Error(`Maksymalnie ${MAX_OPEN_MARKETS} otwartych rynków naraz.`);
  return insertMarket(guildId, { ...parsed.value, source: 'custom' });
}

// ---------------------------------------------------------------- display ----

const bar = (share) => {
  const filled = Math.round(share * 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
};

/** The embed + buttons for a market. */
export function buildMarketMessage(market, pools, economy) {
  const stats = describePools(pools);
  const embed = new EmbedBuilder()
    .setColor(COLORS[market.status] ?? COLORS.open)
    .setTitle(`📈 ${market.question}`.slice(0, 256));
  const lines = market.options.map((option, i) => {
    const s = stats.options[i];
    const won = market.status === 'resolved' && market.winner === i;
    const parts = [`${won ? '✅ ' : ''}**${option.label}**`];
    parts.push(`${bar(s.share)} ${Math.round(s.share * 100)}%`);
    parts.push(`${formatCoins(economy, s.total)} · ${s.bets} zakł.`);
    if (market.status === 'open' && s.multiplier) parts.push(`x${s.multiplier.toFixed(2)}`);
    if (option.price !== null && option.price !== undefined)
      parts.push(`Polymarket: ${Math.round(option.price * 100)}%`);
    return parts.join('\n');
  });
  let description = market.description ? `${market.description.slice(0, 600)}\n\n` : '';
  description += lines.join('\n\n');
  if (market.status === 'cancelled') description += '\n\n⚠️ Rynek anulowany — zakłady zwrócone.';
  embed.setDescription(description.slice(0, 4000));
  const footer = [`Rynek #${market.id}`, `Pula: ${coinsText(economy, stats.total)}`];
  if (market.source === 'polymarket') footer.push('dane: Polymarket');
  if (market.source === 'cs2') footer.push('dane: Leetify');
  embed.setFooter({ text: footer.join(' • ') });
  if (market.status === 'open' && market.closesAt)
    embed.addFields({ name: 'Zakłady do', value: `<t:${Math.floor(market.closesAt / 1000)}:f>` });
  if (market.status !== 'open') return { embeds: [embed], components: [] };

  const rows = [];
  market.options.forEach((option, i) => {
    if (i % 5 === 0) rows.push(new ActionRowBuilder());
    rows[rows.length - 1].addComponents(
      new ButtonBuilder()
        .setCustomId(`${BET_PREFIX}${market.id}:${i}`)
        .setLabel(option.label.slice(0, 80))
        .setStyle(ButtonStyle.Primary)
    );
  });
  return { embeds: [embed], components: rows };
}

async function marketPayload(market) {
  const { economy } = await loadSettings(market.guildId);
  return buildMarketMessage(market, await optionPools(market.id, market.options.length), economy);
}

/**
 * Post a market to a channel, or refresh its message when it is already there.
 * @returns {Promise<'sent'|'updated'>}
 */
export async function publishMarket(guild, market, channelId = '') {
  const targetId = channelId || market.channelId;
  if (!targetId) throw new Error('Wybierz kanał, na który wysłać rynek.');
  const payload = await marketPayload(market);
  if (market.messageId && (!channelId || channelId === market.channelId)) {
    const existing = await guild.channels.cache
      .get(market.channelId)
      ?.messages?.fetch(market.messageId)
      .catch(() => null);
    if (existing) {
      await existing.edit(payload);
      return 'updated';
    }
  }
  const posted = await postToChannel(guild.id, targetId, payload);
  if (!posted) throw new Error('Nie mogę wysłać wiadomości na ten kanał. Sprawdź uprawnienia bota.');
  await setMarketMessage(market.id, targetId, posted.messageId);
  return 'sent';
}

const refreshTimers = new Map();
/** Edit a market's channel message soon (bets arriving together share one edit). */
export function scheduleRefresh(marketId, delayMs = 3000) {
  if (refreshTimers.has(marketId)) return;
  const timer = setTimeout(async () => {
    refreshTimers.delete(marketId);
    try {
      const market = await getMarket(marketId);
      const guild = market && runtime.client?.guilds.cache.get(market.guildId);
      if (guild && market.messageId) await publishMarket(guild, market);
    } catch (error) {
      log.warn('module:markets', `refresh of market ${marketId} failed:`, error.message ?? error);
    }
  }, delayMs);
  timer.unref?.();
  refreshTimers.set(marketId, timer);
}

// ------------------------------------------------------------------- bets ----

/**
 * Place a bet. The coins are debited first (one guarded UPDATE), then the bet
 * is recorded only if the market is still open; when it isn't, the coins go back.
 * @returns {Promise<{ ok: true, balance: number, market: object } | { ok: false, error: string }>}
 */
export async function placeBet(guildId, userId, marketId, optionIdx, rawAmount) {
  const settings = await loadSettings(guildId);
  if (!settings.marketsEnabled) return { ok: false, error: 'Rynki są wyłączone na tym serwerze.' };
  if (!settings.economyEnabled) return { ok: false, error: 'Moduł Ekonomia jest wyłączony.' };
  const market = await getGuildMarket(guildId, marketId);
  if (!market || market.status !== 'open') return { ok: false, error: 'Ten rynek jest już zamknięty.' };
  if (market.closesAt && market.closesAt <= Date.now())
    return { ok: false, error: 'Zakłady na ten rynek są już zamknięte.' };
  if (!market.options[optionIdx]) return { ok: false, error: 'Nie ma takiej opcji.' };
  const amount = Math.floor(Number(String(rawAmount).replace(/\s/g, '')));
  const { minBet, maxBet } = settings.config;
  if (!Number.isFinite(amount) || amount < minBet || amount > maxBet)
    return {
      ok: false,
      error: `Stawka musi być liczbą od ${coinsText(settings.economy, minBet)} do ${coinsText(settings.economy, maxBet)}.`,
    };

  await ensureAccount(guildId, userId, settings.economy.startingBalance);
  const balance = await debit(guildId, userId, amount);
  if (balance === null) return { ok: false, error: 'Nie masz tylu monet.' };
  let betId;
  try {
    betId = await recordBet(guildId, marketId, userId, optionIdx, amount);
  } catch (error) {
    await credit(guildId, userId, amount);
    throw error;
  }
  if (betId === null) {
    await credit(guildId, userId, amount);
    return { ok: false, error: 'Zakłady na ten rynek właśnie się zamknęły — monety wróciły na konto.' };
  }
  scheduleRefresh(marketId);
  return { ok: true, balance, market, economy: settings.economy };
}

// ------------------------------------------------------------- settlement ----

async function payOut(guildId, bets, payouts) {
  const owners = new Map(bets.map((b) => [b.id, b.userId]));
  const people = new Set();
  let paid = 0;
  for (const { id, payout } of payouts) {
    if (!(await claimPayout(id, payout))) continue;
    if (payout > 0 && owners.has(id)) {
      await credit(guildId, owners.get(id), payout);
      paid += payout;
      people.add(owners.get(id));
    }
  }
  return { paid, people: people.size };
}

async function announce(market, text) {
  if (!market.messageId || !market.channelId) return;
  const economy = (await loadSettings(market.guildId)).economy;
  await postToChannel(market.guildId, market.channelId, {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS[market.status] ?? COLORS.open)
        .setTitle(`📈 ${market.question}`.slice(0, 256))
        .setDescription(text)
        .setFooter({ text: `Rynek #${market.id} • ${economy.currencyName}` }),
    ],
    allowedMentions: { parse: [] },
  });
}

/**
 * Resolve a market: the winning option's backers share the whole pool.
 * Safe to call twice — only the call that flips the market out of "open" pays.
 * @returns {Promise<{ ok: true, paid: number, people: number, refunded: boolean } | { ok: false, error: string }>}
 */
export async function settleMarket(guildId, marketId, winner, note = '') {
  const market = await getGuildMarket(guildId, marketId);
  if (!market) return { ok: false, error: 'Nie znaleziono rynku.' };
  if (market.status !== 'open') return { ok: false, error: 'Ten rynek jest już rozstrzygnięty.' };
  if (!Number.isInteger(winner) || !market.options[winner])
    return { ok: false, error: 'Wybierz zwycięską opcję.' };
  if (!(await markResolved(marketId, winner)))
    return { ok: false, error: 'Ten rynek jest już rozstrzygnięty.' };

  const bets = await betsOfMarket(marketId);
  const refunded = bets.length > 0 && !bets.some((b) => b.optionIdx === winner);
  const result = await payOut(guildId, bets, computePayouts(bets, winner));
  const settled = await getMarket(marketId);
  await finishMarket(
    settled,
    refunded
      ? `Zwycięska opcja: **${settled.options[winner].label}** — nikt na nią nie postawił, więc zakłady zostały zwrócone.${note ? `\n${note}` : ''}`
      : `Zwycięska opcja: ✅ **${settled.options[winner].label}**\nWypłacono ${result.paid.toLocaleString('pl-PL')} monet ${result.people} osobom.${note ? `\n${note}` : ''}`
  );
  return { ok: true, ...result, refunded };
}

/** Cancel a market and give every stake back. */
export async function cancelMarket(guildId, marketId, reason = '') {
  const market = await getGuildMarket(guildId, marketId);
  if (!market) return { ok: false, error: 'Nie znaleziono rynku.' };
  if (!(await markCancelled(marketId))) return { ok: false, error: 'Ten rynek jest już rozstrzygnięty.' };
  const bets = await betsOfMarket(marketId);
  const result = await payOut(guildId, bets, refundAll(bets));
  const cancelled = await getMarket(marketId);
  await finishMarket(
    cancelled,
    reason ||
      `Rynek anulowany — zwrócono ${result.paid.toLocaleString('pl-PL')} monet ${result.people} osobom.`
  );
  return { ok: true, ...result, refunded: true };
}

async function finishMarket(market, text) {
  try {
    const guild = runtime.client?.guilds.cache.get(market.guildId);
    if (guild && market.messageId) await publishMarket(guild, market);
    await announce(market, text);
  } catch (error) {
    log.warn('module:markets', `could not update market ${market.id} message:`, error.message ?? error);
  }
}

// -------------------------------------------------------------- overviews ----

/** Data for the dashboard: every market with its pools. */
export async function marketsOverview(guild) {
  const markets = await listMarkets(guild.id, { limit: 60 });
  const economy = (await loadSettings(guild.id)).economy;
  const out = [];
  for (const market of markets) {
    const pools = await optionPools(market.id, market.options.length);
    const stats = describePools(pools);
    out.push({
      id: market.id,
      question: market.question,
      description: market.description,
      source: market.source,
      sourceRef: market.sourceRef,
      status: market.status,
      winner: market.winner,
      closesAt: market.closesAt,
      channelId: market.channelId,
      published: Boolean(market.messageId),
      total: stats.total,
      options: market.options.map((o, i) => ({
        label: o.label,
        percent: o.price === null || o.price === undefined ? null : Math.round(o.price * 100),
        total: stats.options[i].total,
        bets: stats.options[i].bets,
        share: Math.round(stats.options[i].share * 100),
      })),
    });
  }
  return { markets: out, currency: economy.currencyEmoji, leetify: leetifyConfigured() };
}

export async function myStakes(marketId, userId) {
  return userStakes(marketId, userId);
}

// ------------------------------------------------------------ polymarket sync ----

/** Refresh prices of imported markets and settle those Polymarket has resolved. */
export async function syncPolymarket() {
  const open = await openPolymarketMarkets();
  const bySlug = new Map();
  for (const market of open) bySlug.set(market.sourceRef, [...(bySlug.get(market.sourceRef) ?? []), market]);
  for (const [slug, markets] of bySlug) {
    let event;
    try {
      event = await fetchPolymarketEvent(slug);
    } catch (error) {
      log.warn('module:markets', `sync of ${slug} failed:`, error.message ?? error);
      continue;
    }
    for (const market of markets) {
      if (event.state === 'resolved' && market.options[event.winner]) {
        await settleMarket(market.guildId, market.id, event.winner).catch((e) =>
          log.error('module:markets', `settling ${market.id} failed:`, e.message ?? e)
        );
        continue;
      }
      if (event.state === 'void') {
        await cancelMarket(market.guildId, market.id).catch((e) =>
          log.error('module:markets', `cancelling ${market.id} failed:`, e.message ?? e)
        );
        continue;
      }
      if (event.options.length === market.options.length) {
        const merged = market.options.map((o, i) => ({ ...o, price: event.options[i].price }));
        await setMarketOptions(market.id, merged);
        scheduleRefresh(market.id, 500);
      }
    }
  }
}

const syncTimer = setInterval(() => {
  syncPolymarket().catch((error) =>
    log.error('module:markets', 'Polymarket sync failed:', error.message ?? error)
  );
  syncCs2().catch((error) => log.error('module:markets', 'CS2 sync failed:', error.message ?? error));
}, SYNC_MS);
syncTimer.unref();

// -------------------------------------------------------------- components ----

const say = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

/** A bet button: ask for the stake in a small form. */
export async function handleBetButton(interaction) {
  const [, , marketId, optionIdx] = interaction.customId.split(':');
  const settings = await loadSettings(interaction.guildId);
  if (!settings.enabled) return say(interaction, 'Rynki są teraz wyłączone na tym serwerze.');
  const market = await getGuildMarket(interaction.guildId, Number(marketId));
  const option = market?.options[Number(optionIdx)];
  if (!market || market.status !== 'open' || !option)
    return say(interaction, 'Ten rynek jest już zamknięty.');
  if (market.closesAt && market.closesAt <= Date.now())
    return say(interaction, 'Zakłady na ten rynek są już zamknięte.');
  const { minBet, maxBet } = settings.config;
  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${market.id}:${optionIdx}`)
    .setTitle(`Zakład: ${option.label}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel('Ile monet chcesz postawić?')
          .setPlaceholder(`${minBet} – ${maxBet}`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(15)
      )
    );
  return interaction.showModal(modal);
}

/** The stake form was submitted. */
export async function handleBetModal(interaction) {
  const [, , marketId, optionIdx] = interaction.customId.split(':');
  const result = await placeBet(
    interaction.guildId,
    interaction.user.id,
    Number(marketId),
    Number(optionIdx),
    interaction.fields.getTextInputValue('amount')
  );
  if (!result.ok) return say(interaction, `❌ ${result.error}`);
  const label = result.market.options[Number(optionIdx)].label;
  const stakes = await userStakes(Number(marketId), interaction.user.id);
  const mine = stakes.get(Number(optionIdx)) ?? 0;
  return say(
    interaction,
    `✅ Postawiono na **${label}**. Łącznie na tę opcję: ${formatCoins(result.economy, mine)}. Saldo: ${formatCoins(result.economy, result.balance)}`
  );
}

registerComponent('markets', BET_PREFIX, handleBetButton);
registerComponent('markets', MODAL_PREFIX, handleBetModal);

/** Delete a finished market (and its channel message). Open markets must be settled or cancelled first. */
export async function removeMarket(guild, marketId) {
  const market = await getGuildMarket(guild.id, marketId);
  if (!market) return { ok: false, error: 'Nie znaleziono rynku.' };
  if (market.status === 'open')
    return { ok: false, error: 'Najpierw rozstrzygnij albo anuluj rynek — inaczej zakłady przepadłyby.' };
  await deleteChannelMessage(guild.id, market.channelId, market.messageId);
  await deleteMarket(guild.id, marketId);
  return { ok: true };
}
