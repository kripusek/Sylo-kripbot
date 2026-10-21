import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getComposedMessage, saveComposedMessage, ApiError } from '../api.js';
import EmbedCard, { autoGrow, newKey } from '../components/EmbedCard.jsx';

const HEX_RE = /^#[0-9a-f]{6}$/i;
const MAX_EMBEDS = 10;
const MAX_LINKS = 5;

function normEmbed(e = {}) {
  return {
    key: newKey('e'),
    color: HEX_RE.test(e.color) ? e.color : '#5865f2',
    authorName: String(e.authorName || ''),
    authorIcon: String(e.authorIcon || ''),
    title: String(e.title || ''),
    description: String(e.description || ''),
    image: String(e.image || ''),
    thumbnail: String(e.thumbnail || ''),
    footerText: String(e.footerText || ''),
    footerIcon: String(e.footerIcon || ''),
    fieldsBeside: e.fieldsBeside === true,
    fields: (Array.isArray(e.fields) ? e.fields : []).map((f) => ({
      key: newKey('f'),
      name: String(f.name || ''),
      value: String(f.value || ''),
      inline: Boolean(f.inline),
    })),
  };
}

// A composed message's `rows` can also hold a role-select/role-button row —
// built by the Reaction roles module, not this page. Keep whatever isn't a
// plain link-button row untouched so saving here never drops it.
function specToForm(spec) {
  const rows = Array.isArray(spec?.rows) ? spec.rows : [];
  const keepRows = rows.filter(
    (r) => r.type !== 'random' && (r.type !== 'buttons' || (r.buttons || []).some((b) => b.style !== 'link'))
  );
  const randomRow = rows.find((r) => r.type === 'random');
  const links = rows
    .flatMap((r) => (r.type === 'buttons' ? r.buttons || [] : []))
    .filter((b) => b.style === 'link' || b.url)
    .map((b) => ({ label: b.label || '', url: b.url || '', emoji: b.emoji || '' }));
  return {
    content: String(spec?.content || ''),
    embeds: (Array.isArray(spec?.embeds) ? spec.embeds : []).map(normEmbed),
    links,
    keepRows,
    random: {
      enabled: Boolean(randomRow),
      label: String(randomRow?.label || ''),
      vsMode: Boolean(randomRow?.vsMode),
      pool: (randomRow?.pool || []).join('\n'),
      categories: (randomRow?.categories || []).join('\n'),
      categoryCount: Number(randomRow?.categoryCount) || 1,
    },
  };
}

const toLines = (text) =>
  String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

function formToSpec(form) {
  const embeds = form.embeds.map((e) => ({
    kind: 'embed',
    color: e.color,
    authorName: e.authorName,
    authorIcon: e.authorIcon,
    title: e.title,
    description: e.description,
    image: e.image,
    thumbnail: e.thumbnail,
    footerText: e.footerText,
    footerIcon: e.footerIcon,
    fieldsBeside: e.fieldsBeside === true,
    fields: e.fields
      .map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) }))
      .filter((f) => f.name || f.value),
  }));
  const buttons = form.links
    .map((b) => ({
      style: 'link',
      label: String(b.label || '').trim(),
      emoji: String(b.emoji || '').trim(),
      url: String(b.url || '').trim(),
    }))
    .filter((b) => b.url && (b.label || b.emoji));
  const rows = buttons.length ? [...form.keepRows, { type: 'buttons', buttons }] : [...form.keepRows];
  if (form.random.enabled) {
    rows.push({
      type: 'random',
      label: form.random.label.trim(),
      vsMode: form.random.vsMode,
      pool: toLines(form.random.pool),
      categories: toLines(form.random.categories),
      categoryCount: Math.max(1, Math.min(10, Math.floor(Number(form.random.categoryCount)) || 1)),
    });
  }
  return { content: form.content, embeds, rows };
}

export default function MessageBuilder() {
  const { guildId, id } = useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';

  const [state, setState] = useState({ loading: true, error: null });
  const [form, setForm] = useState(null);
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [messageId, setMessageId] = useState(null);
  const [channels, setChannels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getComposedMessage(guildId, id)
      .then((d) => {
        if (cancelled) return;
        setName(d.rec.name);
        setChannelId(d.rec.channelId);
        setMessageId(d.rec.messageId);
        const initial = specToForm(d.rec.spec);
        // "+ New random message" on the Random messages module opens a draft with the button on.
        if (isNew && new URLSearchParams(window.location.search).get('random') === '1')
          initial.random.enabled = true;
        setForm(initial);
        setChannels(d.channels);
        setState({ loading: false, error: null });
      })
      .catch((error) => !cancelled && setState({ loading: false, error }));
    return () => {
      cancelled = true;
    };
  }, [guildId, id]);

  if (state.loading || !form) return <p className="v2-state">Loading…</p>;

  if (state.error) {
    const notAuthed = state.error instanceof ApiError && state.error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load this embed message (${state.error.message}).`
        )}
      </p>
    );
  }

  const addEmbed = () => {
    if (form.embeds.length >= MAX_EMBEDS) return;
    setForm((f) => ({ ...f, embeds: [...f.embeds, normEmbed({})] }));
  };
  const updateEmbed = (i, next) =>
    setForm((f) => ({ ...f, embeds: f.embeds.map((e, idx) => (idx === i ? next : e)) }));
  const removeEmbed = (i) => setForm((f) => ({ ...f, embeds: f.embeds.filter((_, idx) => idx !== i) }));
  const duplicateEmbed = (i) =>
    setForm((f) => {
      if (f.embeds.length >= MAX_EMBEDS) return f;
      const copy = normEmbed({ ...f.embeds[i], fields: f.embeds[i].fields.map((field) => ({ ...field })) });
      const embeds = [...f.embeds];
      embeds.splice(i + 1, 0, copy);
      return { ...f, embeds };
    });
  const moveEmbed = (i, d) =>
    setForm((f) => {
      const j = i + d;
      if (j < 0 || j >= f.embeds.length) return f;
      const embeds = [...f.embeds];
      const [item] = embeds.splice(i, 1);
      embeds.splice(j, 0, item);
      return { ...f, embeds };
    });

  const addLink = () => {
    if (form.links.length >= MAX_LINKS) return;
    setForm((f) => ({ ...f, links: [...f.links, { label: '', emoji: '', url: '' }] }));
  };
  const updateLink = (i, patch) =>
    setForm((f) => ({ ...f, links: f.links.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) }));
  const removeLink = (i) => setForm((f) => ({ ...f, links: f.links.filter((_, idx) => idx !== i) }));
  const setRandom = (patch) => setForm((f) => ({ ...f, random: { ...f.random, ...patch } }));

  async function submit(action) {
    setBusy(true);
    setNotice(null);
    try {
      const body = { name, channelId, action, spec: formToSpec(form) };
      const { rec, status, error } = await saveComposedMessage(guildId, id, body);
      if (error) {
        setNotice({ kind: 'bad', text: error });
      } else {
        setNotice({
          kind: 'ok',
          text: {
            saved: 'Draft saved.',
            sent: 'Published to the channel.',
            updated: 'Published message updated.',
          }[status],
        });
        setChannelId(rec.channelId);
        setMessageId(rec.messageId);
        if (isNew) navigate(`/guilds/${guildId}/messages/${rec.id}`, { replace: true });
      }
    } catch (err) {
      setNotice({ kind: 'bad', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <div className="v2-page-head">
        <input
          type="text"
          className="v2-mb-name"
          maxLength={100}
          placeholder="Untitled embed"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="v2-field-row">
          <button
            type="button"
            className="v2-btn-ghost"
            onClick={() => navigate(`/guilds/${guildId}/messages`)}
          >
            Discard
          </button>
          <button type="button" className="v2-btn-ghost" disabled={busy} onClick={() => submit('save')}>
            Save draft
          </button>
          <button type="button" className="v2-btn-primary" disabled={busy} onClick={() => submit('publish')}>
            {messageId ? 'Update published' : 'Publish'}
          </button>
        </div>
      </div>

      {notice ? <p className={notice.kind === 'ok' ? 'v2-note' : 'v2-row-warn'}>{notice.text}</p> : null}

      <div className="v2-field v2-section-gap">
        <label htmlFor="channelId">Channel</label>
        <select id="channelId" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          <option value="">— select a channel —</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
        {messageId ? (
          <p className="v2-field-hint">
            Published — "Update published" edits the posted message; changing the channel posts a fresh one.
          </p>
        ) : null}
      </div>

      <h2 className="v2-group-title v2-section-gap">Message</h2>
      <p className="v2-field-hint">
        This is a live preview — click straight into any part of it to edit. To ping a role, type it into the
        message text as {'<@&ROLE_ID>'}; mentions placed inside an embed don't notify anyone.
      </p>

      <div className="v2-msg-preview">
        <div className="v2-msg-head">
          <div className="v2-msg-avatar">S</div>
          <div className="v2-msg-head-text">
            <span className="v2-msg-botname">Krip-bot</span>
            <span className="v2-msg-botbadge">BOT</span>
            <span className="v2-msg-time">Today</span>
          </div>
        </div>
        <textarea
          className="v2-msg-content"
          rows={1}
          maxLength={2000}
          placeholder="Write your message here!"
          value={form.content}
          onChange={(e) => {
            autoGrow(e);
            setForm((f) => ({ ...f, content: e.target.value }));
          }}
          onFocus={autoGrow}
        />

        {form.embeds.map((embed, i) => (
          <EmbedCard
            key={embed.key}
            embed={embed}
            onChange={(next) => updateEmbed(i, next)}
            toolbar={{
              index: i,
              count: form.embeds.length,
              onMove: (d) => moveEmbed(i, d),
              onDuplicate: () => duplicateEmbed(i),
              onRemove: () => removeEmbed(i),
            }}
          />
        ))}

        <button
          type="button"
          className="v2-embed-add"
          disabled={form.embeds.length >= MAX_EMBEDS}
          onClick={addEmbed}
        >
          + Add embed
        </button>
      </div>

      <h2 className="v2-group-title v2-section-gap">
        Link buttons <span className="v2-field-hint">— optional, up to {MAX_LINKS}</span>
      </h2>
      {form.links.map((link, i) => (
        <div className="v2-field-row v2-section-gap-sm" key={i}>
          <input
            type="text"
            placeholder="Label"
            maxLength={80}
            value={link.label}
            onChange={(e) => updateLink(i, { label: e.target.value })}
          />
          <input
            type="text"
            placeholder="emoji"
            maxLength={64}
            value={link.emoji}
            onChange={(e) => updateLink(i, { emoji: e.target.value })}
          />
          <input
            type="text"
            placeholder="https://…"
            value={link.url}
            onChange={(e) => updateLink(i, { url: e.target.value })}
          />
          <button type="button" className="v2-btn-ghost" onClick={() => removeLink(i)}>
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        className="v2-btn-ghost v2-section-gap-sm"
        disabled={form.links.length >= MAX_LINKS}
        onClick={addLink}
      >
        + Add link button
      </button>

      <h2 className="v2-group-title v2-section-gap">
        Losowy przycisk (DM) <span className="v2-field-hint">— opcjonalnie</span>
      </h2>
      <p className="v2-field-hint">
        Pod wiadomością pojawi się przycisk. Każdy może kliknąć raz i dostaje w DM losową linię z Twojej
        listy. Działa po opublikowaniu wiadomości na kanale.
      </p>
      <label className="v2-check">
        <input
          type="checkbox"
          checked={form.random.enabled}
          onChange={(e) => setRandom({ enabled: e.target.checked })}
        />
        Dodaj losowy przycisk
      </label>
      {form.random.enabled ? (
        <>
          <div className="v2-field">
            <label>Napis na przycisku</label>
            <input
              type="text"
              maxLength={80}
              placeholder="Losuj"
              value={form.random.label}
              onChange={(e) => setRandom({ label: e.target.value })}
            />
          </div>
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.random.vsMode}
              onChange={(e) => setRandom({ vsMode: e.target.checked })}
            />
            Tryb VS — bot losuje dwie różne pozycje z listy i pokazuje je jako „A vs B"
          </label>
          <div className="v2-field">
            <label>
              Lista do losowania{' '}
              <span className="v2-field-hint">— jedna linia = jedna możliwość (słowo lub zdanie)</span>
            </label>
            <textarea
              rows={6}
              placeholder={'kot\nDzisiaj będzie dobry dzień\nbanan'}
              value={form.random.pool}
              onChange={(e) => setRandom({ pool: e.target.value })}
            />
          </div>
          {form.random.vsMode ? (
            <div className="v2-field">
              <label>
                Kategorie do trybu VS{' '}
                <span className="v2-field-hint">
                  — opcjonalnie, jedna linia = jedna kategoria, np. „kto lepszy?"
                </span>
              </label>
              <textarea
                rows={3}
                placeholder={'kto lepszy?\nkto wygra w walce?'}
                value={form.random.categories}
                onChange={(e) => setRandom({ categories: e.target.value })}
              />
            </div>
          ) : null}
          {form.random.vsMode ? (
            <div className="v2-field">
              <label>
                Ile kategorii wylosować{' '}
                <span className="v2-field-hint">
                  — bot dopisze tyle różnych kategorii (1–10, nie więcej niż masz na liście)
                </span>
              </label>
              <input
                type="number"
                min={1}
                max={10}
                step={1}
                value={form.random.categoryCount}
                onChange={(e) => setRandom({ categoryCount: e.target.value })}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </form>
  );
}
