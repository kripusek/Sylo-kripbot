// V1 dashboard JSON endpoints for prediction markets (see lib/marketRoutes.js).
import { Router } from 'express';
import { getGuild } from '../lib/guildContext.js';
import { requireGuildAdmin } from '../middleware/auth.js';
import { registerMarketRoutes } from '../lib/marketRoutes.js';

const router = Router({ mergeParams: true });
router.use((req, res, next) => {
  req.guild = getGuild(req);
  if (!req.guild) return res.status(404).json({ error: 'Nie znaleziono serwera.' });
  next();
});
router.use(requireGuildAdmin);
registerMarketRoutes(router, '');

export default router;
