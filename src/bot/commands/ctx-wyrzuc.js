// User menu: right-click a member → Apps → Wyrzuć (same as /kick; same access rules).
import { userMenu, modalMenu, reasonInput } from '../lib/contextMenus.js';
import { applyKick } from './kick.js';

export const data = userMenu('Wyrzuć');
export const execute = modalMenu({
  commandName: 'Wyrzuć',
  prefix: 'ctxkick:',
  title: 'Wyrzuć',
  fields: [reasonInput()],
  run: (interaction, { member, reason }) => applyKick(interaction, member, reason),
});
