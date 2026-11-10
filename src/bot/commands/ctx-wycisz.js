// User menu: right-click a member → Apps → Wycisz (same as /timeout; same access rules).
import { userMenu, modalMenu, reasonInput, durationInput } from '../lib/contextMenus.js';
import { applyTimeout } from './timeout.js';

export const data = userMenu('Wycisz');
export const execute = modalMenu({
  commandName: 'Wycisz',
  prefix: 'ctxmute:',
  title: 'Wycisz',
  fields: [durationInput(true), reasonInput()],
  run: (interaction, { member, reason, text }) => applyTimeout(interaction, member, reason, text('duration')),
});
