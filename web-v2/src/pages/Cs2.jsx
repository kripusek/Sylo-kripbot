import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch } from '../api.js';
import { useApiData } from '../useApiData.js';

const statuses = {
  pending: 'Oczekujący',
  won: 'Wygrany',
  lost: 'Przegrany',
  tie: 'Remis',
  expired: 'Zwrot — brak meczu',
};
const modes = {
  rush: 'Rush',
  wingman: 'Wingman',
  competitive: 'Competitive',
  premier: 'Premier',
  any: 'Dowolny',
};
const date = (value) => (value ? new Date(value).toLocaleString('pl-PL') : '—');
export default function Cs2() {
  const { guildId } = useParams();
  return <Cs2Panel key={guildId} />;
}

function Cs2Panel() {
  const { guildId } = useParams();
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const { data, loading, error } = useApiData(
    () => apiFetch(`/api/v2/guilds/${guildId}/cs2?page=${page}`),
    [guildId, page, refresh]
  );
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    setForm(null);
    setPage(0);
    setMessage('');
  }, [guildId]);
  useEffect(() => {
    if (data) setForm((current) => current ?? data.config);
  }, [data]);
  const setCs2 = (patch) => {
    setForm((current) => ({ ...current, ...patch }));
    setMessage('');
  };
  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const result = await apiFetch(`/api/v2/guilds/${guildId}/cs2/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      setForm(result.config);
      setMessage('Zapisano ustawienia.');
    } catch (err) {
      setMessage(`Błąd zapisu: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }
  if (error)
    return (
      <p className="v2-state" role="alert">
        Nie udało się wczytać CS2: {error.message}
      </p>
    );
  if (!data || !form) return <p className="v2-state">Ładowanie…</p>;
  return (
    <>
      <h1 className="v2-section-title">CS2</h1>
      {!data.enabled && (
        <p className="v2-field-hint">Ekonomia jest wyłączona. Włącz ją, aby przyjmować nowe zakłady.</p>
      )}
      <section className="v2-group">
        <h2 className="v2-group-title">Historia zakładów</h2>
        <p className="v2-field-hint">
          Zakłady wszystkich graczy na tym serwerze, od najnowszych. Wypłata obejmuje zwrot stawki.
        </p>
        <button type="button" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>
          Odśwież
        </button>
        <div style={{ overflowX: 'auto' }}>
          <table className="v2-cs2-history">
            <thead>
              <tr>
                {[
                  'ID',
                  'Gracz (Discord ID)',
                  'Cel zakładu (Discord ID)',
                  'Typ',
                  'Tryb',
                  'Stawka',
                  'Status',
                  'Wypłata',
                  'Zysk / strata',
                  'Postawiono',
                  'Rozliczono',
                ].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.bets.map((bet) => (
                <tr key={bet.id}>
                  <td>#{bet.id}</td>
                  <td>{bet.userId}</td>
                  <td>{bet.targetId || bet.userId}</td>
                  <td>{bet.pick === 'lose' ? 'Przegra' : 'Wygra'}</td>
                  <td>{modes[bet.mode] || bet.mode}</td>
                  <td>{bet.amount.toLocaleString('pl-PL')}</td>
                  <td>{statuses[bet.status] || bet.status}</td>
                  <td>{bet.status === 'pending' ? '—' : bet.payout.toLocaleString('pl-PL')}</td>
                  <td>
                    {bet.status === 'pending' ? '—' : (bet.payout - bet.amount).toLocaleString('pl-PL')}
                  </td>
                  <td>{date(bet.createdAt)}</td>
                  <td>{date(bet.settledAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.bets.length && <p>Brak zakładów na tej stronie.</p>}
        <div className="v2-section-gap-sm">
          <button type="button" disabled={!page || loading} onClick={() => setPage((n) => n - 1)}>
            Poprzednia
          </button>
          <span> Strona {page + 1} </span>
          <button type="button" disabled={!data.hasMore || loading} onClick={() => setPage((n) => n + 1)}>
            Następna
          </button>
        </div>
      </section>
      <form className="v2-group" onSubmit={save}>
        <h3 className="v2-section-gap-sm">Zakłady CS2 — ogłoszenia wyników</h3>
        <p className="v2-field-hint">
          Gdzie i jak ogłaszany jest wynik stawki z <code>/gry cs2</code>. Pusta wiadomość = domyślna.
          Znaczniki: {'{user} {amount} {payout} {multiplier} {map} {score} {mode} {currency}'}.
        </p>
        <div className="v2-field">
          <label htmlFor="cs2Channel">Kanał ogłoszeń</label>
          <select
            id="cs2Channel"
            value={form?.channelId ?? ''}
            onChange={(e) => setCs2({ channelId: e.target.value })}
          >
            <option value="">— kanał, na którym postawiono stawkę —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form?.ping !== false}
              onChange={(e) => setCs2({ ping: e.target.checked })}
            />
            Pinguj gracza (powiadomienie)
          </label>
        </div>
        <div className="v2-field">
          <label htmlFor="cs2NoPing">Rola „bez pingów”</label>
          <select
            id="cs2NoPing"
            value={form?.noPingRoleId ?? ''}
            onChange={(e) => setCs2({ noPingRoleId: e.target.value })}
          >
            <option value="">— brak (bez przycisku) —</option>
            {data.roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">
            Po wybraniu roli każde ogłoszenie ma przycisk; kliknięcie nadaje lub zabiera rolę, a osoby z rolą
            nie są pingowane. Bot potrzebuje „Zarządzanie rolami”, a rola musi być pod jego najwyższą rolą.
          </p>
        </div>
        {[
          ['winMessage', 'Wiadomość o wygranej'],
          ['lossMessage', 'Wiadomość o przegranej'],
          ['tieMessage', 'Wiadomość o remisie'],
          ['expiredMessage', 'Wiadomość o braku meczu (zwrot)'],
        ].map(([key, label]) => (
          <div className="v2-field" key={key}>
            <label htmlFor={`cs2-${key}`}>{label}</label>
            <textarea
              id={`cs2-${key}`}
              rows={2}
              maxLength={400}
              value={form?.[key] ?? ''}
              onChange={(e) => setCs2({ [key]: e.target.value })}
            />
          </div>
        ))}
        <button type="submit" className="v2-btn-primary" disabled={saving}>
          {saving ? 'Zapisywanie…' : 'Zapisz ustawienia CS2'}
        </button>
        <p role="status">{message}</p>
      </form>
    </>
  );
}
