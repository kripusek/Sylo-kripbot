import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig } from '../api.js';
import { useApiData } from '../useApiData.js';
export default function AutoThreads() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'auto-threads'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (data) setForm(data.config);
  }, [data]);
  if (error) return <p className="v2-state">Błąd ładowania: {error.message}</p>;
  if (loading || !form) return <p className="v2-state">Ładowanie…</p>;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setStatus('');
    try {
      const result = await saveModuleConfig(guildId, 'auto-threads', form);
      setForm(result.config);
      setStatus('Zapisano.');
    } catch (err) {
      setStatus(err.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <h1 className="v2-section-title">Automatyczne wątki</h1>
      <p className="v2-field-hint">
        Publiczny wątek pod każdą nową wiadomością człowieka na wybranych kanałach. Pomija boty, webhooki i
        wiadomości wewnątrz wątków. Nie przetwarza starszych wiadomości.
      </p>
      <form onSubmit={save}>
        <div className="v2-field">
          <label>Kanały</label>
          {data.channels.map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={form.channelIds.includes(c.id)}
                onChange={(e) =>
                  set({
                    channelIds: e.target.checked
                      ? [...form.channelIds, c.id]
                      : form.channelIds.filter((id) => id !== c.id),
                  })
                }
              />{' '}
              #{c.name}
            </label>
          ))}
        </div>
        <div className="v2-field">
          <label htmlFor="threadName">Nazwa wątku</label>
          <input
            id="threadName"
            maxLength={100}
            value={form.nameTemplate}
            onChange={(e) => set({ nameTemplate: e.target.value })}
          />
          <p className="v2-field-hint">
            Zmienne: {'{author}'} i {'{message}'}. Treść wymaga Message Content Intent.
          </p>
        </div>
        <div className="v2-field">
          <label htmlFor="threadArchive">Archiwizacja po braku aktywności</label>
          <select
            id="threadArchive"
            value={form.autoArchiveDuration}
            onChange={(e) => set({ autoArchiveDuration: Number(e.target.value) })}
          >
            {[
              [60, '1 godzina'],
              [1440, '1 dzień'],
              [4320, '3 dni'],
              [10080, '7 dni'],
            ].map(([v, n]) => (
              <option key={v} value={v}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <button className="v2-btn-primary" disabled={saving}>
          {saving ? 'Zapisywanie…' : 'Zapisz'}
        </button>
        <p role="status">{status}</p>
      </form>
      <p className="v2-field-hint">
        Włącz moduł. Bot potrzebuje uprawnień: Wyświetlanie kanału, Czytanie historii wiadomości i Tworzenie
        publicznych wątków.
      </p>
    </>
  );
}
