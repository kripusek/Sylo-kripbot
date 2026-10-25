// Public pages for linking a Steam account: /steam/start sends the member to
// Steam's sign-in, /steam/callback checks Steam's answer and stores the link.
// Both only accept a signed, short-lived token from the /steam polacz command.
import { Router } from 'express';
import { config } from '../../config.js';
import { log } from '../../lib/log.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { saveSteamLink } from '../../db/cs2.js';
import {
  verifySteamToken,
  steamLoginUrl,
  returnUrl,
  verifySteamAssertion,
} from '../../modules/lib/steamLink.js';

const router = Router();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res, status, title, text) {
  res
    .status(status)
    .set('cache-control', 'no-store')
    .send(
      `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e8e9ec;display:grid;place-items:center;min-height:100vh;margin:0}` +
        `main{max-width:30rem;padding:2rem;text-align:center}h1{font-size:1.4rem}p{color:#a9adb8;line-height:1.5}</style></head>` +
        `<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`
    );
}

router.get('/start', (req, res) => {
  if (!config.dashboardUrl) return page(res, 503, 'Niedostępne', 'Administrator nie ustawił DASHBOARD_URL.');
  if (!verifySteamToken(req.query.t))
    return page(res, 400, 'Link wygasł', 'Użyj ponownie komendy /steam polacz na Discordzie.');
  res.redirect(steamLoginUrl(config.dashboardUrl, String(req.query.t)));
});

router.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const token = String(req.query.t ?? '');
    const who = verifySteamToken(token);
    if (!who || !config.dashboardUrl)
      return page(res, 400, 'Link wygasł', 'Użyj ponownie komendy /steam polacz na Discordzie.');
    let steamId = null;
    try {
      steamId = await verifySteamAssertion(req.query, returnUrl(config.dashboardUrl, token));
    } catch (error) {
      log.warn('steam-link', `Steam verification failed: ${error.message}`);
    }
    if (!steamId)
      return page(
        res,
        400,
        'Nie udało się',
        'Steam nie potwierdził logowania. Spróbuj jeszcze raz z /steam polacz.'
      );
    const result = await saveSteamLink(who.guildId, who.userId, steamId);
    if (result === 'taken')
      return page(
        res,
        409,
        'Konto zajęte',
        'To konto Steam jest już połączone z innym użytkownikiem Discorda.'
      );
    page(
      res,
      200,
      'Steam połączony ✅',
      'Możesz zamknąć tę kartę i wrócić na Discorda. Teraz zadziała /gry cs2.'
    );
  })
);

export default router;
