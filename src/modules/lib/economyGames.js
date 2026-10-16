// Pure game logic for the economy mini-games — no Discord, no database, so every
// rule (and every payout multiplier) can be tested. Randomness comes from an
// injectable `rng` (a function returning an integer in [0, max)), defaulting to
// crypto.randomInt, so tests can script outcomes.
//
// A result's `multiplier` is the TOTAL returned for the stake: 0 = stake lost,
// 1 = stake refunded, 2 = stake doubled, and so on. The bet is taken before the
// round and `payoutFor(bet, multiplier)` is paid back after it.
import { randomInt } from 'node:crypto';

/** @typedef {(max: number) => number} Rng */
/** @type {Rng} */
export const defaultRng = (max) => randomInt(max);

/** Total coins paid back for a stake at a multiplier (rounded down). */
export function payoutFor(bet, multiplier) {
  return Math.floor(bet * multiplier);
}

// ------------------------------------------------------------------ coinflip ----
export const COIN_SIDES = ['orzel', 'reszka'];
export const COINFLIP_MULTIPLIER = 2;

/** @param {'orzel'|'reszka'} choice */
export function coinflip(choice, rng = defaultRng) {
  const result = COIN_SIDES[rng(2)];
  const win = result === choice;
  return { result, win, multiplier: win ? COINFLIP_MULTIPLIER : 0 };
}

// --------------------------------------------------------------- guess 1–5 ----
export const GUESS_MAX = 5;
export const GUESS_MULTIPLIER = 4;

/** @param {number} choice 1–5 */
export function guessNumber(choice, rng = defaultRng) {
  const number = rng(GUESS_MAX) + 1;
  const win = number === choice;
  return { number, win, multiplier: win ? GUESS_MULTIPLIER : 0 };
}

// ----------------------------------------------------------------------- rps ----
export const RPS_CHOICES = ['kamien', 'papier', 'nozyce'];
const RPS_BEATS = { kamien: 'nozyce', papier: 'kamien', nozyce: 'papier' };

/** Free play (no stake): rock-paper-scissors against the bot. */
export function rps(choice, rng = defaultRng) {
  const bot = RPS_CHOICES[rng(3)];
  const outcome = choice === bot ? 'draw' : RPS_BEATS[choice] === bot ? 'win' : 'lose';
  return { bot, outcome };
}

// ---------------------------------------------------------------------- dice ----
export const DICE_WIN_MULTIPLIER = 2;

/** A d6 for the player against a d6 for the bot; a tie refunds the stake. */
export function dice(rng = defaultRng) {
  const player = rng(6) + 1;
  const bot = rng(6) + 1;
  const outcome = player > bot ? 'win' : player < bot ? 'lose' : 'draw';
  return {
    player,
    bot,
    outcome,
    multiplier: outcome === 'win' ? DICE_WIN_MULTIPLIER : outcome === 'draw' ? 1 : 0,
  };
}

// --------------------------------------------------------------------- slots ----
export const SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '🔔', '⭐', '7️⃣'];
export const SLOTS_JACKPOT_MULTIPLIER = 5;
export const SLOTS_PAIR_MULTIPLIER = 2;

/** Three reels: three alike is the jackpot, exactly two alike pays a pair. */
export function slots(rng = defaultRng) {
  const reels = [0, 1, 2].map(() => SLOT_SYMBOLS[rng(SLOT_SYMBOLS.length)]);
  const distinct = new Set(reels).size;
  const outcome = distinct === 1 ? 'jackpot' : distinct === 2 ? 'pair' : 'lose';
  return {
    reels,
    outcome,
    multiplier:
      outcome === 'jackpot' ? SLOTS_JACKPOT_MULTIPLIER : outcome === 'pair' ? SLOTS_PAIR_MULTIPLIER : 0,
  };
}

// ------------------------------------------------------------------ roulette ----
// 15 pockets: 0 green, 1–7 red, 8–14 black (the common "Rust/CS" wheel).
export const ROULETTE_POCKETS = 15;
export const ROULETTE_TYPES = ['czerwone', 'czarne', 'zielone'];
export const ROULETTE_MULTIPLIERS = { czerwone: 2, czarne: 2, zielone: 14 };

export function rouletteColor(pocket) {
  return pocket === 0 ? 'zielone' : pocket <= 7 ? 'czerwone' : 'czarne';
}

/** @param {'czerwone'|'czarne'|'zielone'} type */
export function roulette(type, rng = defaultRng) {
  const pocket = rng(ROULETTE_POCKETS);
  const color = rouletteColor(pocket);
  const win = color === type;
  return { pocket, color, win, multiplier: win ? ROULETTE_MULTIPLIERS[type] : 0 };
}

// --------------------------------------------------------------------- cups ----
export const CUPS = 3;
export const CUPS_MULTIPLIER = 2.5;

/** A ball under one of three cups. @param {number} choice 1–3 */
export function cups(choice, rng = defaultRng) {
  const ball = rng(CUPS) + 1;
  const win = ball === choice;
  return { ball, win, multiplier: win ? CUPS_MULTIPLIER : 0 };
}

// ------------------------------------------------------------------- cards ----
const SUITS = ['♠', '♥', '♦', '♣'];
const RANK_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

/** @typedef {{ rank: number, suit: string }} Card */

export function newDeck() {
  return SUITS.flatMap((suit) => Array.from({ length: 13 }, (_, i) => ({ rank: i + 2, suit })));
}

/** Fisher–Yates shuffle (returns a new array). */
export function shuffle(cards, rng = defaultRng) {
  const deck = [...cards];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = rng(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export const cardLabel = (card) => `${RANK_LABELS[card.rank] ?? card.rank}${card.suit}`;
export const handLabel = (cards) => cards.map(cardLabel).join(' ');

// ----------------------------------------------------------------- blackjack ----
export const BLACKJACK_NATURAL_MULTIPLIER = 2.5;
export const BLACKJACK_WIN_MULTIPLIER = 2;

/** Best blackjack total (aces count 11 until that would bust), plus whether it is soft. */
export function blackjackValue(cards) {
  let total = 0;
  let aces = 0;
  for (const { rank } of cards) {
    if (rank === 14) {
      aces += 1;
      total += 11;
    } else total += rank >= 11 ? 10 : rank;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

const isNatural = (cards) => cards.length === 2 && blackjackValue(cards).total === 21;

/**
 * Deal a round. If either side has a natural 21 the round is settled at once.
 * @returns {{ deck: Card[], player: Card[], dealer: Card[], done: boolean, result: object | null }}
 */
export function blackjackDeal(rng = defaultRng) {
  const deck = shuffle(newDeck(), rng);
  const state = {
    deck,
    player: [deck.pop(), deck.pop()],
    dealer: [deck.pop(), deck.pop()],
    done: false,
    result: null,
  };
  if (isNatural(state.player) || isNatural(state.dealer)) {
    state.done = true;
    state.result = blackjackSettle(state);
  }
  return state;
}

export function blackjackHit(state) {
  if (state.done) return state;
  state.player.push(state.deck.pop());
  const { total } = blackjackValue(state.player);
  if (total > 21) {
    state.done = true;
    state.result = blackjackSettle(state);
  } else if (total === 21) {
    blackjackStand(state); // 21: nothing left to decide
  }
  return state;
}

/** Dealer draws to 17 (standing on all 17s), then the round is settled. */
export function blackjackStand(state) {
  if (state.done) return state;
  while (blackjackValue(state.dealer).total < 17) state.dealer.push(state.deck.pop());
  state.done = true;
  state.result = blackjackSettle(state);
  return state;
}

/** Outcome of a finished (or naturally decided) round. */
export function blackjackSettle(state) {
  const p = blackjackValue(state.player).total;
  const d = blackjackValue(state.dealer).total;
  const pNatural = isNatural(state.player);
  const dNatural = isNatural(state.dealer);
  if (p > 21) return { outcome: 'bust', multiplier: 0, player: p, dealer: d };
  if (pNatural && dNatural) return { outcome: 'push', multiplier: 1, player: p, dealer: d };
  if (pNatural)
    return { outcome: 'blackjack', multiplier: BLACKJACK_NATURAL_MULTIPLIER, player: p, dealer: d };
  if (dNatural) return { outcome: 'lose', multiplier: 0, player: p, dealer: d };
  if (d > 21 || p > d) return { outcome: 'win', multiplier: BLACKJACK_WIN_MULTIPLIER, player: p, dealer: d };
  if (p === d) return { outcome: 'push', multiplier: 1, player: p, dealer: d };
  return { outcome: 'lose', multiplier: 0, player: p, dealer: d };
}

// --------------------------------------------------------------------- poker ----
export const POKER_WIN_MULTIPLIER = 2;
export const HAND_NAMES = [
  'Wysoka karta',
  'Para',
  'Dwie pary',
  'Trójka',
  'Strit',
  'Kolor',
  'Full',
  'Kareta',
  'Poker',
  'Poker królewski',
];

/**
 * Rank a five-card hand. `category` is an index into HAND_NAMES; `tiebreak` lists
 * the card ranks in the order they decide a tie between equal categories.
 * @param {Card[]} cards exactly five
 */
export function evaluateHand(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Group by count, then by rank, both descending: [[rank, count], …]
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every((c) => c.suit === cards[0].suit);

  const unique = [...new Set(ranks)];
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) straightHigh = unique[0];
    else if (unique[0] === 14 && unique[1] === 5 && unique[4] === 2) straightHigh = 5; // A-2-3-4-5
  }

  const shape = groups.map((g) => g[1]).join('');
  const byGroup = groups.map((g) => g[0]);
  let category;
  let tiebreak = byGroup;
  if (straightHigh && flush) {
    category = straightHigh === 14 ? 9 : 8;
    tiebreak = [straightHigh];
  } else if (shape === '41') category = 7;
  else if (shape === '32') category = 6;
  else if (flush) {
    category = 5;
    tiebreak = ranks;
  } else if (straightHigh) {
    category = 4;
    tiebreak = [straightHigh];
  } else if (shape === '311') category = 3;
  else if (shape === '221') category = 2;
  else if (shape === '2111') category = 1;
  else {
    category = 0;
    tiebreak = ranks;
  }
  return { category, name: HAND_NAMES[category], tiebreak };
}

/** Positive if `a` beats `b`, negative if it loses, 0 for an exact tie. */
export function compareHands(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i += 1) {
    const diff = (a.tiebreak[i] ?? 0) - (b.tiebreak[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** Five cards each from one shuffled deck; the better hand wins, a tie refunds the stake. */
export function poker(rng = defaultRng) {
  const deck = shuffle(newDeck(), rng);
  const player = deck.splice(0, 5);
  const bot = deck.splice(0, 5);
  const playerHand = evaluateHand(player);
  const botHand = evaluateHand(bot);
  const cmp = compareHands(playerHand, botHand);
  const outcome = cmp > 0 ? 'win' : cmp < 0 ? 'lose' : 'draw';
  return {
    player,
    bot,
    playerHand,
    botHand,
    outcome,
    multiplier: outcome === 'win' ? POKER_WIN_MULTIPLIER : outcome === 'draw' ? 1 : 0,
  };
}
