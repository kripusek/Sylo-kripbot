// Pure maths and Polymarket parsing for the prediction-market module. No
// database, no Discord, no network — everything here is unit-testable.

export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 10;
export const QUESTION_MAX = 200;
export const DESCRIPTION_MAX = 800;
export const OPTION_MAX = 60;

/**
 * Split a pool between winners in proportion to their stake (parimutuel).
 * Uses BigInt because stake × pool can pass 2^53 on a big server.
 *  - nobody backed the winner → everybody is refunded
 *  - otherwise each winning bet gets floor(stake × totalPool / winnerPool); losers get 0
 *    (the few coins lost to rounding stay out of circulation, never created).
 * @param {Array<{ id: number, optionIdx: number, amount: number }>} bets
 * @param {number} winner  index of the winning option
 * @returns {Array<{ id: number, payout: number }>}
 */
export function computePayouts(bets, winner) {
  const total = bets.reduce((sum, b) => sum + BigInt(b.amount), 0n);
  const winnerPool = bets.reduce((sum, b) => (b.optionIdx === winner ? sum + BigInt(b.amount) : sum), 0n);
  if (winnerPool === 0n) return bets.map((b) => ({ id: b.id, payout: b.amount }));
  return bets.map((b) => ({
    id: b.id,
    payout: b.optionIdx === winner ? Number((BigInt(b.amount) * total) / winnerPool) : 0,
  }));
}

/** Everyone gets their stake back (cancelled market). */
export const refundAll = (bets) => bets.map((b) => ({ id: b.id, payout: b.amount }));

/**
 * Display numbers for one market: each option's pool share and the multiplier a
 * new coin would earn if that option won with the pools as they are now.
 * @param {Array<{ total: number }>} pools
 */
export function describePools(pools) {
  const total = pools.reduce((sum, p) => sum + p.total, 0);
  return {
    total,
    options: pools.map((p) => ({
      total: p.total,
      bets: p.bets ?? 0,
      share: total > 0 ? p.total / total : 0,
      multiplier: p.total > 0 ? total / p.total : null,
    })),
  };
}

/** Clean the editable fields of a market. Returns `{ ok, value }` or `{ ok:false, error }`. */
export function normaliseMarketInput(raw = {}) {
  const question = String(raw.question ?? '')
    .trim()
    .slice(0, QUESTION_MAX);
  if (question.length < 3) return { ok: false, error: 'Wpisz pytanie rynku (przynajmniej 3 znaki).' };
  const labels = (Array.isArray(raw.options) ? raw.options : String(raw.options ?? '').split(/\r?\n/))
    .map((o) =>
      String(typeof o === 'object' && o ? (o.label ?? '') : o)
        .trim()
        .slice(0, OPTION_MAX)
    )
    .filter(Boolean);
  const unique = [...new Map(labels.map((l) => [l.toLowerCase(), l])).values()];
  if (unique.length < OPTIONS_MIN) return { ok: false, error: 'Dodaj przynajmniej dwie różne opcje.' };
  if (unique.length > OPTIONS_MAX) return { ok: false, error: `Maksymalnie ${OPTIONS_MAX} opcji.` };
  const closesAt = parseClosesAt(raw.closesAt);
  if (closesAt === null) return { ok: false, error: 'Nieprawidłowa data zamknięcia zakładów.' };
  return {
    ok: true,
    value: {
      question,
      description: String(raw.description ?? '')
        .trim()
        .slice(0, DESCRIPTION_MAX),
      options: unique.map((label) => ({ label, price: null })),
      closesAt,
    },
  };
}

/** Accepts epoch ms, an ISO / datetime-local string, or empty (= no deadline). Null when unreadable. */
export function parseClosesAt(value) {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return 0;
  const ms =
    typeof value === 'number' ? value : /^\d{10,}$/.test(String(value)) ? Number(value) : Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : null;
}

// ------------------------------------------------------------- Polymarket ----

const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/i;

/** A Polymarket event slug from a pasted URL or a bare slug; null when it isn't one. */
export function parsePolymarketSlug(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (SLUG.test(text)) return text.toLowerCase();
  try {
    const url = new URL(text);
    if (!/(^|\.)polymarket\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const at = parts.findIndex((p) => p === 'event' || p === 'market');
    const slug = at >= 0 ? parts[at + 1] : null;
    return slug && SLUG.test(slug) ? slug.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Gamma returns `outcomes` / `outcomePrices` as JSON *strings*; tolerate real arrays too.
const list = (v) => {
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const WIN = 0.999;
const LOSE = 0.001;
const finished = (m) =>
  m?.closed === true &&
  (!m.umaResolutionStatus || String(m.umaResolutionStatus).toLowerCase() === 'resolved');

/**
 * Turn a Polymarket event (as returned by the Gamma API) into our options plus
 * its current state.
 *  - one market  → one option per outcome (Yes/No, team names, …)
 *  - many markets (e.g. "Who will win?") → one option per market, priced by its "Yes"
 * State: 'open' | 'resolved' (with `winner`) | 'void' (all outcomes 50/50) |
 * 'pending' (closed but no clear winner yet — an admin settles it by hand).
 * @returns {{ question: string, description: string, options: Array<{label:string, price:number|null}>,
 *   closesAt: number, state: string, winner: number } | null}
 */
export function evaluatePolymarketEvent(event) {
  const markets = (Array.isArray(event?.markets) ? event.markets : []).filter(Boolean);
  if (!markets.length) return null;
  const base = {
    question: String(event.title ?? markets[0].question ?? '').slice(0, QUESTION_MAX),
    description: String(event.description ?? markets[0].description ?? '').slice(0, DESCRIPTION_MAX),
    closesAt: parseClosesAt(event.endDate ?? markets[0].endDate) || 0,
  };
  const price = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
  };

  if (markets.length === 1) {
    const m = markets[0];
    const labels = list(m.outcomes).map(String);
    const prices = list(m.outcomePrices).map(price);
    if (labels.length < OPTIONS_MIN || labels.length > OPTIONS_MAX) return null;
    const options = labels.map((label, i) => ({
      label: label.slice(0, OPTION_MAX),
      price: prices[i] ?? null,
    }));
    if (!finished(m) || prices.length !== labels.length || prices.some((p) => p === null))
      return { ...base, options, state: 'open', winner: -1 };
    const winners = prices.flatMap((p, i) => (p >= WIN ? [i] : []));
    if (winners.length === 1 && prices.every((p, i) => i === winners[0] || p <= LOSE))
      return { ...base, options, state: 'resolved', winner: winners[0] };
    if (prices.every((p) => Math.abs(p - 1 / prices.length) < 0.01))
      return { ...base, options, state: 'void', winner: -1 };
    return { ...base, options, state: m.closed === true ? 'pending' : 'open', winner: -1 };
  }

  if (markets.length > OPTIONS_MAX) return null;
  const options = markets.map((m) => {
    const labels = list(m.outcomes).map((o) => String(o).toLowerCase());
    const yes = Math.max(0, labels.indexOf('yes'));
    return {
      label: String(m.groupItemTitle || m.question || '?').slice(0, OPTION_MAX),
      price: price(list(m.outcomePrices)[yes]),
      yes,
    };
  });
  const clean = options.map(({ label, price: p }) => ({ label, price: p }));
  if (!markets.every(finished)) return { ...base, options: clean, state: 'open', winner: -1 };
  const winners = options.flatMap((o, i) => (o.price !== null && o.price >= WIN ? [i] : []));
  if (winners.length === 1) return { ...base, options: clean, state: 'resolved', winner: winners[0] };
  return { ...base, options: clean, state: 'pending', winner: -1 };
}
