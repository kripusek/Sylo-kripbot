// User menu: right-click a member → Apps → Zbanuj (same as /ban; same access rules).
import { userMenu, modalMenu, reasonInput, durationInput } from '../lib/contextMenus.js';
import { applyBan } from './ban.js';

export const data = userMenu('Zbanuj');
export const execute = modalMenu({
  commandName: 'Zbanuj',
  prefix: 'ctxban:',
  title: 'Zbanuj',
  fields: [reasonInput(), durationInput(false, 'Czas (puste = na stałe; np. 7d)')],
  run: (interaction, { user, member, reason, text }) =>
    applyBan(interaction, {
      user,
      member,
      reason,
      deleteMessageSeconds: 0,
      durationInput: text('duration') || null,
    }),
});
