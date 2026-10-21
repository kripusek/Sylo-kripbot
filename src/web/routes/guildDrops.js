// Dashboard page for random drops: messages with a one-click button that DMs the
// member a random line from a list.
import { Router } from 'express';
import { getGuild, baseContext } from '../lib/guildContext.js';
import { requireGuildAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { guildTextChannels } from '../lib/discord.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { listDrops, getDrop, saveDrop, deleteDrop } from '../../db/randomDrops.js';
import { normaliseDrop, publishDrop, POOL_MAX_LINES } from '../../modules/randomDrops.js';

const router = Router({ mergeParams: true });
router.use((req, res, next) => {
  req.guild = getGuild(req);
  if (!req.guild) return res.status(404).json({ error: 'Nie znaleziono serwera.' });
  next();
});
router.use(requireGuildAdmin);

const MAX_DROPS = 25;
const json = (d) => ({
  id: d.id,
  name: d.name,
  channelId: d.channel_id,
  published: Boolean(d.message_id),
  text: d.text,
  buttonLabel: d.button_label,
  pool: d.pool,
  claims: d.claims ?? 0,
});
const ownDrop = async (req) => {
  const id = Number(req.params.id);
  const drop = Number.isInteger(id) ? await getDrop(id) : null;
  return drop?.guild_id === req.guild.id ? drop : null;
};

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.render('guild-drops', {
      ...(await baseContext(req.guild, 'drops')),
      channels: guildTextChannels(req.guild),
      maxLines: POOL_MAX_LINES,
    });
  })
);

router.get(
  '/list',
  asyncHandler(async (req, res) => {
    res.json({ drops: (await listDrops(req.guild.id)).map(json) });
  })
);

router.post(
  '/save',
  rateLimit({ windowMs: 60_000, max: 60 }),
  asyncHandler(async (req, res) => {
    const fields = normaliseDrop(req.body);
    let id = null;
    if (req.body.id) {
      req.params.id = req.body.id;
      if (!(await ownDrop(req))) return res.status(404).json({ error: 'Nie znaleziono wiadomości.' });
      id = Number(req.body.id);
    } else if ((await listDrops(req.guild.id)).length >= MAX_DROPS) {
      return res.status(400).json({ error: `Maksymalnie ${MAX_DROPS} wiadomości na serwer.` });
    }
    const savedId = await saveDrop(req.guild.id, id, fields);
    res.json({ drop: json({ ...(await getDrop(savedId)), claims: 0 }) });
  })
);

router.post(
  '/:id/publish',
  rateLimit({ windowMs: 60_000, max: 20 }),
  asyncHandler(async (req, res) => {
    const drop = await ownDrop(req);
    if (!drop) return res.status(404).json({ error: 'Nie znaleziono wiadomości.' });
    try {
      res.json({ status: await publishDrop(req.guild, drop) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  })
);

router.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    const drop = await ownDrop(req);
    if (!drop) return res.status(404).json({ error: 'Nie znaleziono wiadomości.' });
    await deleteDrop(req.guild.id, drop.id);
    res.json({ ok: true });
  })
);

export default router;
