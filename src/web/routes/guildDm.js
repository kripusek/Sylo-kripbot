// Dashboard DM inbox: message a member from the bot and read their replies.
import { Router } from 'express';
import { getGuild, baseContext } from '../lib/guildContext.js';
import { requireGuildAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  listDmThreads,
  listDmMessages,
  markDmRead,
  dmThreadExists,
  deleteDmThread,
} from '../../db/dmInbox.js';
import { sendDirectMessage, DmInboxError, DM_MAX_LENGTH } from '../../modules/dmInbox.js';

const router = Router({ mergeParams: true });
router.use((req, res, next) => {
  req.guild = getGuild(req);
  if (!req.guild) return res.status(404).json({ error: 'Nie znaleziono serwera.' });
  next();
});
router.use(requireGuildAdmin);

const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const nameOf = (guild, id) => {
  const member = guild.members.cache.get(id);
  return member ? member.displayName : id;
};
const actorName = (req) => req.session?.user?.username ?? 'dashboard';

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.render('guild-dm', { ...(await baseContext(req.guild, 'dm')), maxLength: DM_MAX_LENGTH });
  })
);

router.get(
  '/threads',
  asyncHandler(async (req, res) => {
    const rows = await listDmThreads(req.guild.id);
    res.json({
      threads: rows.map((t) => ({
        userId: t.user_id,
        name: nameOf(req.guild, t.user_id),
        lastAt: Number(t.last_at),
        unread: Number(t.unread),
      })),
    });
  })
);

router.get(
  '/:userId/messages',
  asyncHandler(async (req, res) => {
    if (!isId(req.params.userId)) return res.status(400).json({ error: 'Nieprawidłowe ID.' });
    const messages = await listDmMessages(req.guild.id, req.params.userId, req.query.after);
    await markDmRead(req.guild.id, req.params.userId);
    res.json({
      name: nameOf(req.guild, req.params.userId),
      messages: messages.map((m) => ({
        id: Number(m.id),
        direction: m.direction,
        author: m.author,
        content: m.content,
        at: Number(m.created_at),
      })),
    });
  })
);

router.post(
  '/send',
  rateLimit({ windowMs: 60_000, max: 20 }),
  asyncHandler(async (req, res) => {
    const message = await sendDirectMessage(req.guild, req.body.userId, req.body.content, actorName(req));
    res.status(201).json({ message });
  })
);

router.post(
  '/:userId/delete',
  asyncHandler(async (req, res) => {
    if (!isId(req.params.userId) || !(await dmThreadExists(req.guild.id, req.params.userId)))
      return res.status(404).json({ error: 'Nie znaleziono rozmowy.' });
    await deleteDmThread(req.guild.id, req.params.userId);
    res.json({ ok: true });
  })
);

router.use((error, req, res, next) => {
  if (error instanceof DmInboxError) return res.status(error.status).json({ error: error.message });
  next(error);
});
export default router;
