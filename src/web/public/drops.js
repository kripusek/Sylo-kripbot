(() => {
  const root = document.getElementById('drops');
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = 'true';
  const base = root.dataset.base;
  const $ = (id) => root.querySelector('#' + id);
  const list = $('dr-list');
  const empty = $('dr-empty');
  const form = $('dr-form');
  const status = $('dr-status');
  const del = $('dr-delete');
  let drops = [];

  const notice = (text, error = false) => {
    status.textContent = text;
    status.dataset.error = String(error);
  };
  async function api(path, body) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? {
            'content-type': 'application/json',
            'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || '',
          }
        : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Nie udało się wykonać operacji.');
    return result;
  }

  function show(drop) {
    form.hidden = false;
    form.elements.id.value = drop?.id ?? '';
    form.elements.name.value = drop?.name ?? '';
    form.elements.channelId.value = drop?.channelId ?? '';
    form.elements.text.value = drop?.text ?? '';
    form.elements.buttonLabel.value = drop?.buttonLabel ?? '';
    form.elements.pool.value = (drop?.pool ?? []).join('\n');
    form.elements.categories.value = (drop?.categories ?? []).join('\n');
    form.elements.vsMode.checked = Boolean(drop?.vsMode);
    syncVs();
    del.hidden = !drop;
    $('dr-claims').textContent = drop
      ? `Odebrano: ${drop.claims}. ${drop.published ? 'Wiadomość jest na kanale.' : 'Jeszcze nie wysłano na kanał.'}`
      : '';
    notice('');
    renderList();
  }

  function renderList() {
    list.replaceChildren();
    empty.hidden = drops.length > 0;
    for (const drop of drops) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dm-thread' + (String(drop.id) === form.elements.id.value ? ' active' : '');
      button.textContent = drop.name;
      button.addEventListener('click', () => show(drop));
      li.append(button);
      list.append(li);
    }
  }

  async function load(selectId) {
    drops = (await api('/list')).drops;
    const selected = drops.find((d) => d.id === selectId);
    if (selected) show(selected);
    else renderList();
  }

  const payload = () => ({
    ...Object.fromEntries(new FormData(form).entries()),
    vsMode: form.elements.vsMode.checked,
  });
  function syncVs() {
    $('dr-cats').hidden = !form.elements.vsMode.checked;
  }
  form.elements.vsMode.addEventListener('change', syncVs);

  async function save() {
    const { drop } = await api('/save', payload());
    await load(drop.id);
    return drop;
  }

  $('dr-new').addEventListener('click', () => show(null));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await save();
      notice('Zapisano.');
    } catch (error) {
      notice(error.message, true);
    }
  });

  $('dr-publish').addEventListener('click', async () => {
    try {
      const drop = await save();
      const { status: result } = await api(`/${drop.id}/publish`, {});
      await load(drop.id);
      notice(result === 'updated' ? 'Zapisano i zaktualizowano wiadomość na kanale.' : 'Wysłano na kanał.');
    } catch (error) {
      notice(error.message, true);
    }
  });

  del.addEventListener('click', async () => {
    const id = form.elements.id.value;
    if (
      !id ||
      !window.confirm(
        'Usunąć tę wiadomość z panelu? Wiadomość na kanale zostaje, ale przycisk przestanie działać.'
      )
    )
      return;
    try {
      await api(`/${id}/delete`, {});
      form.hidden = true;
      await load();
    } catch (error) {
      notice(error.message, true);
    }
  });

  load().catch((error) => notice(error.message, true));
})();
