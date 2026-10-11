import { startWebApp, post } from './helpers/webApp.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPresenceConfig } from '../src/db/appSettings.js';

test('V1 and V2 personalizer persist rotation lists and render them after reload', async () => {
  const app = await startWebApp();
  try {
    const updates = [];
    app.client.user.setPresence = (value) => updates.push(value);
    const res = await post(app.base, '/settings/presence', {
      status: 'online',
      type: 'Custom',
      text: 'fallback',
      texts: 'serowa pizza\nfrytki',
      rotationSeconds: '90',
    });
    assert.equal(res.status, 302);
    assert.equal(updates.length, 1);
    assert.ok(['serowa pizza', 'frytki'].includes(updates[0].activities[0].state));
    const cfg = await getPresenceConfig();
    assert.deepEqual(cfg.texts, ['serowa pizza', 'frytki']);
    assert.equal(cfg.rotationSeconds, 90);
    const html = await (await fetch(`${app.base}/settings`)).text();
    assert.match(html, /name="texts"/);
    assert.match(html, /serowa pizza\nfrytki/);
    const api = await fetch(`${app.base}/api/v2/personalizer/presence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'idle',
        type: 'Custom',
        text: '',
        texts: ['a', 'b', 'c'],
        rotationSeconds: 120,
      }),
    });
    assert.equal(api.status, 200);
    assert.deepEqual((await api.json()).presence.texts, ['a', 'b', 'c']);
    const read = await fetch(`${app.base}/api/v2/personalizer/presence`);
    assert.equal((await read.json()).presence.rotationSeconds, 120);
  } finally {
    app.close();
  }
});
