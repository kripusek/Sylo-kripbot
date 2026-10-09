import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

export default function Logging() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'logging'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setForm(data.config);
  }, [data]);

  if ((loading && !data) || !form) return <p className="v2-state">Loading…</p>;

  if (error) {
    const notAuthed = error instanceof ApiError && error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load Server logging settings (${error.message}).`
        )}
      </p>
    );
  }

  const setEvent = (key, checked) => setForm((f) => ({ ...f, events: { ...f.events, [key]: checked } }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const { config } = await saveModuleConfig(guildId, 'logging', form);
      setForm(config);
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Server logging</h1>
      <p className="v2-field-hint">
        Posts member / message / role / channel events to a log channel as they happen.
      </p>

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label htmlFor="channel">Default log channel</label>
          <select
            id="channel"
            value={form.channel}
            onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value }))}
          >
            <option value="">— none —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label>Events to log</label>
          <div className="v2-check-grid">
            {data.logEvents.map(([key, label]) => (
              <div key={key}>
                <label className="v2-check">
                  <input
                    type="checkbox"
                    checked={Boolean(form.events[key])}
                    onChange={(e) => setEvent(key, e.target.checked)}
                  />
                  {label}
                </label>
                <label htmlFor={`channel_${key}`}>Channel for {label}</label>
                <select
                  id={`channel_${key}`}
                  value={form.eventChannels?.[key] || ''}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, eventChannels: { ...f.eventChannels, [key]: e.target.value } }))
                  }
                >
                  <option value="">Use default channel</option>
                  {data.channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>

        <p className="v2-field-hint">
          Message sent copies new messages from members. DMs, bots, webhooks and configured log channels are
          excluded. Inform members, restrict log access and define a retention period. Copies remain after the
          original is deleted. Message Content Intent is required to include text.
        </p>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
        </div>
      </form>
    </>
  );
}
