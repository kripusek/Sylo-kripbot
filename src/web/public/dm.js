(() => {
  const root = document.getElementById('dm-inbox');
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = 'true';
  const base = root.dataset.base;
  const $ = (id) => root.querySelector('#' + id);
  const list = $('dm-threads');
  const empty = $('dm-empty');
  const log = $('dm-log');
  const title = $('dm-title');
  const form = $('dm-send');
  const status = $('dm-status');
  const del = $('dm-delete');
  let current = null;
  let lastId = 0;

  const notice = (text, error = false) => {
    status.textContent = text;
    status.dataset.error = String(error);
  };
  const csrf = () => document.querySelector('meta[name="csrf-token"]')?.content || '';
  async function api(path, body) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json', 'x-csrf-token': csrf() } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Nie udało się wykonać operacji.');
    return result;
  }
  const time = (ms) =>
    new Date(ms).toLocaleString('pl-PL', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  function addMessages(messages) {
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
    for (const m of messages) {
      lastId = Math.max(lastId, m.id);
      const row = document.createElement('div');
      row.className = 'dm-msg ' + (m.direction === 'in' ? 'in' : 'out');
      const meta = document.createElement('div');
      meta.className = 'dm-meta muted small';
      meta.textContent =
        (m.direction === 'in' ? m.author || 'Użytkownik' : 'Bot (' + (m.author || 'panel') + ')') +
        ' · ' +
        time(m.at);
      const body = document.createElement('div');
      body.className = 'dm-body';
      body.textContent = m.content;
      row.append(meta, body);
      log.append(row);
    }
    if (stick || lastId === messages.at(-1)?.id) log.scrollTop = log.scrollHeight;
  }

  async function loadThreads() {
    const { threads } = await api('/threads');
    list.replaceChildren();
    empty.hidden = threads.length > 0;
    for (const t of threads) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dm-thread' + (t.userId === current ? ' active' : '');
      button.textContent = t.name + (t.unread ? ` (${t.unread})` : '');
      button.addEventListener('click', () => open(t.userId));
      li.append(button);
      list.append(li);
    }
  }

  async function open(userId) {
    current = userId;
    lastId = 0;
    log.replaceChildren();
    form.hidden = false;
    del.hidden = false;
    notice('');
    await refresh(true);
    loadThreads().catch(() => {});
  }

  async function refresh(first = false) {
    if (!current) return;
    const id = current;
    try {
      const data = await api(`/${id}/messages?after=${lastId}`);
      if (id !== current) return;
      title.textContent = data.name;
      addMessages(data.messages);
      if (first && !data.messages.length) log.textContent = 'Brak wiadomości — napisz pierwszą.';
      else if (data.messages.length && log.firstChild?.nodeType === 3) log.firstChild.remove();
    } catch (error) {
      notice(error.message, true);
    }
  }

  $('dm-new').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = new FormData(event.target).get('userId').trim();
    if (/^\d{17,20}$/.test(value)) open(value);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const textarea = form.elements.content;
    const content = textarea.value.trim();
    if (!content || !current) return;
    notice('Wysyłanie…');
    try {
      const { message } = await api('/send', { userId: current, content });
      textarea.value = '';
      if (log.firstChild?.nodeType === 3) log.firstChild.remove();
      addMessages([
        { id: message.id, direction: 'out', author: message.author, content, at: message.created_at },
      ]);
      notice('Wysłano.');
      loadThreads().catch(() => {});
    } catch (error) {
      notice(error.message, true);
    }
  });

  del.addEventListener('click', async () => {
    if (!current || !window.confirm('Usunąć całą rozmowę z panelu? Wiadomości na Discordzie zostają.'))
      return;
    try {
      await api(`/${current}/delete`, {});
      current = null;
      log.replaceChildren();
      form.hidden = true;
      del.hidden = true;
      title.textContent = 'Wybierz rozmowę';
      loadThreads().catch(() => {});
    } catch (error) {
      notice(error.message, true);
    }
  });

  loadThreads().catch((error) => notice(error.message, true));
  setInterval(() => {
    if (document.hidden) return;
    refresh();
    loadThreads().catch(() => {});
  }, 5000);
})();
