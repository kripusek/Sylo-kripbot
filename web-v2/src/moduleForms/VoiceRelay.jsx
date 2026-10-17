import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

export default function VoiceRelay() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'voice-relay'), [guildId]);
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState({ running: false });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [relayError, setRelayError] = useState(null);

  useEffect(() => {
    if (data) {
      setForm(data.config);
      setStatus(data.status);
    }
  }, [data]);

  if ((loading && !data) || !form) return <p className="v2-state">Ładowanie…</p>;

  if (error) {
    const notAuthed = error instanceof ApiError && error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Sesja wygasła — <a href="/auth/discord/login">zaloguj się ponownie</a>.
          </>
        ) : (
          `Nie udało się wczytać ustawień relaya (${error.message}).`
        )}
      </p>
    );
  }

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setRelayError(null);
    try {
      const res = await saveModuleConfig(guildId, 'voice-relay', form);
      setForm(res.config);
      setStatus(res.status);
      setRelayError(res.error ?? null);
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  const channelSelect = (key) => (
    <select value={form[key]} onChange={(e) => set({ [key]: e.target.value })}>
      <option value="">— wybierz —</option>
      {data.voiceChannels.map((c) => (
        <option key={c.id} value={c.id}>
          🔊 {c.name}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <h1 className="v2-section-title">Relay głosowy</h1>
      <p className="v2-field-hint">
        Przekazuje na żywo rozmowę z kanału <strong>wejściowego</strong> na kanał <strong>wyjściowy</strong>.
        Jeden bot może być tylko na jednym kanale głosowym serwera, więc relay używa drugiego konta bota:
        główny bot słucha na wejściu, a bot relay mówi na wyjściu. Tryb dwukierunkowy łączy oba kanały ze
        sobą.
      </p>

      {!data.botConfigured ? (
        <p className="v2-error">
          Relay wymaga drugiego bota: utwórz kolejną aplikację w Developer Portal, wpisz jej token do{' '}
          <code>RELAY_BOT_TOKEN</code>, zaproś ją na ten serwer i zrestartuj bota.
        </p>
      ) : !data.botInGuild ? (
        <p className="v2-error">Bot relay nie jest jeszcze na tym serwerze. Zaproś go i zapisz ponownie.</p>
      ) : (
        <p className="v2-field-hint">
          Status:{' '}
          <strong>
            {status.running
              ? `działa (${status.twoWay ? 'dwukierunkowo' : 'jednokierunkowo'}, mówi teraz: ${status.speakers})`
              : 'zatrzymany'}
          </strong>
        </p>
      )}
      {relayError ? <p className="v2-error">Nie uruchomiono: {relayError}</p> : null}

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label>
            Kanał wejściowy <span className="v2-field-hint">— tu słucha główny bot</span>
          </label>
          {channelSelect('inputChannelId')}
        </div>
        <div className="v2-field">
          <label>
            Kanał wyjściowy <span className="v2-field-hint">— tu mówi bot relay</span>
          </label>
          {channelSelect('outputChannelId')}
          <p className="v2-field-hint">
            Tylko zwykłe kanały głosowe (nie sceny). Główny bot potrzebuje Łączenia na wejściu, a bot relay
            Łączenia i Mówienia na wyjściu.
          </p>
        </div>

        <div className="v2-field">
          <button
            type="button"
            className="v2-btn-ghost"
            onClick={() =>
              set({ inputChannelId: form.outputChannelId, outputChannelId: form.inputChannelId })
            }
          >
            ⇅ Zamień wejście z wyjściem
          </button>
        </div>

        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.twoWay}
              onChange={(e) => set({ twoWay: e.target.checked })}
            />
            Dwukierunkowo (oba kanały słyszą się nawzajem)
          </label>
        </div>
        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.announce}
              onChange={(e) => set({ announce: e.target.checked })}
            />
            Napisz komunikat na czacie obu kanałów przy starcie
          </label>
          <p className="v2-field-hint">
            Zostaw włączone, żeby osoby na kanałach wiedziały, że ich głos jest przekazywany dalej.
          </p>
        </div>
        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => set({ active: e.target.checked })}
            />
            Relay włączony
          </label>
          <p className="v2-field-hint">
            Zaznacz i zapisz, aby uruchomić; odznacz i zapisz, aby zatrzymać. Gdy relay działa, na serwerze
            nie da się używać muzyki ani soundboardu.
          </p>
        </div>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Zapisywanie…' : 'Zapisz'}
          </button>
          {saved ? <span className="v2-field-hint"> Zapisano.</span> : null}
        </div>
      </form>
    </>
  );
}
