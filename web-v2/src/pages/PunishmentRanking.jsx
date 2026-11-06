import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch } from '../api.js';
import { useApiData } from '../useApiData.js';

export default function PunishmentRanking() {
  const { guildId } = useParams();
  return <Ranking key={guildId} guildId={guildId} />;
}

function Ranking({ guildId }) {
  const path = `/api/v2/guilds/${guildId}/punishment-ranking`;
  const { data, error, setData } = useApiData(() => apiFetch(path), [guildId]);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('');
  const [users, setUsers] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) { setSelected(data.selected); setUsers((data.users || []).join(', ')); } }, [data]);
  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const result = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles: selected, users: users.match(/\d{17,20}/g) || [] }) });
      setData(result);
      setFilter('');
      setMessage('Zapisano role.');
    } catch (err) { setMessage(`Błąd zapisu: ${err.message}`); }
    finally { setSaving(false); }
  }
  async function changeFilter(role) {
    setFilter(role);
    try {
      const result = await apiFetch(`${path}?role=${encodeURIComponent(role)}`);
      setData(result);
    } catch (err) { setMessage(`Błąd pobierania: ${err.message}`); }
  }
  if (error) return <p role="alert">Nie udało się wczytać rankingu: {error.message}</p>;
  if (!data || !selected) return <p>Ładowanie…</p>;
  return <>
    <h1 className="v2-section-title">Ranking nadawania kar</h1>
    <p className="v2-field-hint">Warny, timeouty, kicki i bany zapisane przez bota, w tym zakończone kary. Kary automatyczne nie są przypisywane moderatorom. Liczą się obecne role członków serwera.</p>
    <form className="v2-group" onSubmit={save}>
      <h2 className="v2-group-title">Role uwzględniane w rankingu</h2>
      {data.roles.map((role) => <label className="v2-check" key={role.id}><input type="checkbox" checked={selected.includes(role.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, role.id] : selected.filter((id) => id !== role.id))} /> {role.name}</label>)}
      <label>Osoby (ID Discord) <input value={users} onChange={(event) => setUsers(event.target.value)} placeholder="ID oddzielone przecinkami" /></label>
      <button className="v2-btn-primary" disabled={saving} type="submit">Zapisz role</button>
      {message && <p role="status">{message}</p>}
    </form>
    <section className="v2-group">
      <label>Filtruj rolę <select value={filter} onChange={(event) => changeFilter(event.target.value)}><option value="">Wszystkie wybrane role</option>{data.roles.filter((role) => data.selected.includes(role.id)).map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
      {data.lookupErrors > 0 && <p role="alert">Nie udało się pobrać części moderatorów z Discorda. Ranking może być niepełny.</p>}
      {!data.selected.length && !data.users?.length ? <p>Wybierz przynajmniej jedną rolę, aby wyświetlić ranking.</p> : !data.ranking.length ? <p>Brak zapisanych kar dla wybranych ról.</p> : <div style={{ overflowX: 'auto' }}><table className="v2-cs2-history"><thead><tr>{['#', 'Moderator', 'Warny', 'Timeouty', 'Kicki', 'Bany', 'Razem'].map((name) => <th key={name}>{name}</th>)}</tr></thead><tbody>{data.ranking.map((row, index) => <tr key={row.id}><td>{index + 1}</td><td>{row.name} ({row.id})</td><td>{row.warn}</td><td>{row.timeout}</td><td>{row.kick}</td><td>{row.ban}</td><td>{row.total}</td></tr>)}</tbody></table></div>}
    </section>
  </>;
}
