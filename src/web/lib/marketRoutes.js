// JSON routes for the prediction-markets dashboard page. Registered twice: under
// /guilds/:guildId/markets for the V1 dashboard and under
// /api/v2/guilds/:guildId/modules/markets for V2, so both panels share one
// implementation. The caller has already loaded `req.guild` and required admin.
import { asyncHandler } from './asyncHandler.js';
import { guildTextChannels } from './discord.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { recordAudit } from '../../db/audit.js';
import { getGuildMarket, getMarket } from '../../db/markets.js';
import { parseClosesAt } from '../../modules/lib/marketMath.js';
import {
  normaliseMarkets,
  createCustomMarket,
  createCs2Market,
  importPolymarket,
  trendingPolymarket,
  publishMarket,
  settleMarket,
  cancelMarket,
  removeMarket,
  marketsOverview,
} from '../../modules/markets.js';

const actor = (req) => req.session?.user?.username ?? 'dashboard';
const channelOk = (guild, id) => /^\d{17,20}$/.test(id ?? '') && guild.channels.cache.has(id);

/**
 * @param {import('express').Router} router
 * @param {string} base  path prefix, e.g. '/guilds/:guildId/modules/markets'
 */
export function registerMarketRoutes(router, base) {
  const audit = (req, detail) =>
    recordAudit(req.guild.id, { actor: actor(req), action: 'markets', detail }).catch(() => {});
  const fail = (res, error, status = 400) =>
    res.status(status).json({ error: error.message ?? String(error) });

  // Publish right after creating when the form asked for it and a channel is known.
  async function maybePublish(req, id, wanted) {
    if (!wanted) return null;
    const channelId = channelOk(req.guild, req.body.channelId)
      ? req.body.channelId
      : normaliseMarkets((await getGuildModule(req.guild.id, 'markets')).config).channelId;
    if (!channelId) return 'Rynek zapisany, ale nie wybrano kanału do publikacji.';
    try {
      await publishMarket(req.guild, await getMarket(id), channelId);
      return null;
    } catch (error) {
      return `Rynek zapisany, ale nie udało się go opublikować: ${error.message}`;
    }
  }

  const overview = asyncHandler(async (req, res) => {
    const { config } = await getGuildModule(req.guild.id, 'markets');
    res.json({
      config: normaliseMarkets(config),
      channels: guildTextChannels(req.guild),
      ...(await marketsOverview(req.guild)),
    });
  });
  // `/config` is the path the V2 shell's generic getModuleConfig() calls.
  router.get(`${base}/overview`, overview);
  router.get(`${base}/config`, overview);

  router.post(
    `${base}/settings`,
    asyncHandler(async (req, res) => {
      const config = normaliseMarkets(req.body);
      await setGuildModule(req.guild.id, 'markets', { config });
      await audit(req, 'settings saved');
      res.json({ config });
    })
  );

  router.get(
    `${base}/trending`,
    rateLimit({ windowMs: 60_000, max: 20 }),
    asyncHandler(async (req, res) => {
      try {
        res.json({ events: await trendingPolymarket(20) });
      } catch (error) {
        fail(res, error, 502);
      }
    })
  );

  router.post(
    `${base}/create`,
    rateLimit({ windowMs: 60_000, max: 30 }),
    asyncHandler(async (req, res) => {
      try {
        const id = await createCustomMarket(req.guild.id, req.body);
        await audit(req, `created market ${id}`);
        res.json({ id, warning: await maybePublish(req, id, req.body.publish) });
      } catch (error) {
        fail(res, error);
      }
    })
  );

  router.post(
    `${base}/create-cs2`,
    rateLimit({ windowMs: 60_000, max: 20 }),
    asyncHandler(async (req, res) => {
      try {
        const closesAt = parseClosesAt(req.body.closesAt);
        if (closesAt === null) throw new Error('Nieprawidłowa data zamknięcia zakładów.');
        const id = await createCs2Market(req.guild.id, { ...req.body, closesAt });
        await audit(req, `created CS2 market ${id} for ${req.body.steamId}`);
        res.json({ id, warning: await maybePublish(req, id, req.body.publish) });
      } catch (error) {
        fail(res, error);
      }
    })
  );

  router.post(
    `${base}/import`,
    rateLimit({ windowMs: 60_000, max: 20 }),
    asyncHandler(async (req, res) => {
      try {
        const id = await importPolymarket(req.guild.id, req.body.input);
        await audit(req, `imported polymarket ${req.body.input} as ${id}`);
        res.json({ id, warning: await maybePublish(req, id, req.body.publish) });
      } catch (error) {
        fail(res, error);
      }
    })
  );

  const own = asyncHandler(async (req, res, next) => {
    const market = await getGuildMarket(req.guild.id, Number(req.params.marketId));
    if (!market) return res.status(404).json({ error: 'Nie znaleziono rynku.' });
    req.market = market;
    next();
  });

  router.post(
    `${base}/:marketId/publish`,
    rateLimit({ windowMs: 60_000, max: 30 }),
    own,
    asyncHandler(async (req, res) => {
      try {
        const channelId = channelOk(req.guild, req.body.channelId) ? req.body.channelId : '';
        res.json({ status: await publishMarket(req.guild, req.market, channelId) });
      } catch (error) {
        fail(res, error);
      }
    })
  );

  router.post(
    `${base}/:marketId/settle`,
    rateLimit({ windowMs: 60_000, max: 30 }),
    own,
    asyncHandler(async (req, res) => {
      const result = await settleMarket(req.guild.id, req.market.id, Number(req.body.winner));
      if (!result.ok) return res.status(400).json({ error: result.error });
      await audit(req, `settled market ${req.market.id}, winner ${req.body.winner}`);
      res.json(result);
    })
  );

  router.post(
    `${base}/:marketId/cancel`,
    rateLimit({ windowMs: 60_000, max: 30 }),
    own,
    asyncHandler(async (req, res) => {
      const result = await cancelMarket(req.guild.id, req.market.id);
      if (!result.ok) return res.status(400).json({ error: result.error });
      await audit(req, `cancelled market ${req.market.id}`);
      res.json(result);
    })
  );

  router.post(
    `${base}/:marketId/delete`,
    own,
    asyncHandler(async (req, res) => {
      const result = await removeMarket(req.guild, req.market.id);
      if (!result.ok) return res.status(400).json({ error: result.error });
      await audit(req, `deleted market ${req.market.id}`);
      res.json({ ok: true });
    })
  );
}
