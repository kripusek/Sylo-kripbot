// Linking a Discord member to a Steam account with "Sign in through Steam"
// (OpenID 2.0). Steam itself asserts which SteamID64 logged in, so nobody can
// claim an account that isn't theirs. No Steam API key is needed.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';

export const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const TOKEN_TTL_MS = 10 * 60_000;
const NS = 'http://specs.openid.net/auth/2.0';
const CLAIMED = /^https?:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/;

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (body) => createHmac('sha256', config.sessionSecret).update(`steam-link.${body}`).digest();

/** A short-lived signed token naming the guild and member the link is for. */
export function signSteamToken(guildId, userId, now = Date.now()) {
  const body = `${guildId}.${userId}.${now + TOKEN_TTL_MS}`;
  return `${b64(body)}.${b64(sign(body))}`;
}

/** @returns {{ guildId: string, userId: string } | null} */
export function verifySteamToken(token, now = Date.now()) {
  try {
    const [bodyB64, sigB64] = String(token).split('.');
    if (!bodyB64 || !sigB64) return null;
    const body = Buffer.from(bodyB64, 'base64url').toString();
    const expected = sign(body);
    const got = Buffer.from(sigB64, 'base64url');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    const [guildId, userId, exp] = body.split('.');
    if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(userId)) return null;
    if (now > Number(exp)) return null;
    return { guildId, userId };
  } catch {
    return null;
  }
}

export const returnUrl = (base, token) => `${base}/steam/callback?t=${encodeURIComponent(token)}`;

/** Where to send the browser to sign in with Steam. */
export function steamLoginUrl(base, token) {
  const params = new URLSearchParams({
    'openid.ns': NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnUrl(base, token),
    'openid.realm': base,
    'openid.identity': `${NS}/identifier_select`,
    'openid.claimed_id': `${NS}/identifier_select`,
  });
  return `${STEAM_OPENID}?${params}`;
}

/**
 * Check the assertion Steam sent back and return the SteamID64 it vouches for.
 * Steam is asked to confirm the signature itself (`check_authentication`), which
 * also burns the one-time nonce so a replayed callback fails.
 * @param {Record<string, string>} query  the callback's query parameters
 * @param {string} expectedReturnTo       the return_to this login started with
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string | null>}
 */
export async function verifySteamAssertion(query, expectedReturnTo, fetchImpl = fetch) {
  if (query['openid.mode'] !== 'id_res') return null;
  if (query['openid.op_endpoint'] !== STEAM_OPENID) return null;
  if (query['openid.return_to'] !== expectedReturnTo) return null;
  const id = CLAIMED.exec(String(query['openid.claimed_id'] ?? ''))?.[1];
  if (!id || query['openid.identity'] !== query['openid.claimed_id']) return null;

  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (key.startsWith('openid.') && typeof value === 'string') form.set(key, value);
  form.set('openid.mode', 'check_authentication');
  const res = await fetchImpl(STEAM_OPENID, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return /(^|\n)is_valid:true(\n|$)/.test(await res.text()) ? id : null;
}
