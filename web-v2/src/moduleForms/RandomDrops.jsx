import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getModuleConfig, resetRandomDropLimit, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

// "Reset the one-click limit": everyone, or one member by user ID.
function LimitReset({ guildId, kind, id, onReset }) {
  const [uid, setUid] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run(everyone) {
    if (everyone && !window.confirm('Zresetować limit wszystkim? Każdy będzie mógł kliknąć jeszcze raz.'))
      return;
    setBusy(true);
    setMsg(null);
    try {
      const { reset } = await resetRandomDropLimit(guildId, { kind, id, userId: everyone ? '' : uid.trim() });
      onReset(everyone ? null : reset);
      setMsg({ bad: false, text: reset ? `Zresetowano (${reset}).` : 'Nikt nie miał jeszcze kliknięcia.' });
      if (!everyone) setUid('');
    } catch (err) {
      setMsg({ bad: true, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="v2-field-row">
      <button type="button" className="v2-btn-ghost" disabled={busy} onClick={() => run(true)}>
        Resetuj wszystkim
      </button>
      <input
        type="text"
        inputMode="numeric"
        maxLength={20}
        placeholder="ID osoby"
        aria-label="ID użytkownika do zresetowania"
        value={uid}
        onChange={(e) => setUid(e.target.value)}
      />
      <button
        type="button"
        className="v2-btn-ghost"
        disabled={busy || !uid.trim()}
        onClick={() => run(false)}
      >
        Resetuj osobie
      </button>
      {msg ? (
        <span className="v2-field-hint" style={msg.bad ? { color: 'var(--bad, #ed4245)' } : undefined}>
          {msg.text}
        </span>
      ) : null}
    </div>
  );
}

export default function RandomDrops() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'random-drops'), [guildId]);
  // Claim counts the page has changed locally after a reset: { 'message:7': 0, … }
  const [claims, setClaims] = useState({});

  if (loading && !data) return <p className="v2-state">Loading…</p>;
  if (error) {
    const notAuthed = error instanceof ApiError && error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load Random messages (${error.message}).`
        )}
      </p>
    );
  }

  const channelName = (id) => {
    const c = data.channels.find((x) => x.id === id);
    return c ? `#${c.name}` : '—';
  };
  const { messages, standalone } = data.overview;
  const claimsOf = (kind, item) => claims[`${kind}:${item.id}`] ?? item.claims;
  const afterReset = (kind, item) => (removed) =>
    setClaims((c) => ({
      ...c,
      [`${kind}:${item.id}`]: removed === null ? 0 : Math.max(0, claimsOf(kind, item) - removed),
    }));

  return (
    <div>
      <p className="v2-field-hint">
        Wiadomość z przyciskiem na kanale: każdy może kliknąć raz i dostaje w DM losowe słowo lub zdanie z
        Twojej listy. Wiadomość budujesz pełnym kreatorem embedów, a pod nią włączasz sekcję „Losowy przycisk
        (DM)". Tryb VS losuje dwie pozycje i kategorię. Wyłączenie modułu wyłącza też wszystkie przyciski.
      </p>
      <p>
        <Link className="v2-btn-primary" to={`/guilds/${guildId}/messages/new?random=1`}>
          + Nowa losowa wiadomość
        </Link>
      </p>

      {messages.length === 0 ? (
        <p className="v2-state">Nie masz jeszcze losowych wiadomości.</p>
      ) : (
        <table className="v2-table">
          <thead>
            <tr>
              <th>Wiadomość</th>
              <th>Kanał</th>
              <th>Stan</th>
              <th>Pozycji</th>
              <th>Tryb</th>
              <th>Odebrano</th>
              <th>Limit „raz na osobę"</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td>{channelName(m.channelId)}</td>
                <td>{m.published ? 'Na kanale' : 'Szkic'}</td>
                <td>{m.entries}</td>
                <td>{m.vsMode ? 'VS' : 'Losowa linia'}</td>
                <td>{claimsOf('message', m)}</td>
                <td>
                  <LimitReset guildId={guildId} kind="message" id={m.id} onReset={afterReset('message', m)} />
                </td>
                <td>
                  <Link to={`/guilds/${guildId}/messages/${m.id}`}>Edytuj</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {standalone.length ? (
        <>
          <h2 className="v2-group-title">Starsze wiadomości (osobna strona)</h2>
          <p className="v2-field-hint">
            Utworzone wcześniej na osobnej stronie (panel V1: <code>/guilds/{guildId}/drops</code>). Nadal
            działają.
          </p>
          <ul>
            {standalone.map((d) => (
              <li key={d.id}>
                {d.name} — odebrano: {claimsOf('standalone', d)}
                <LimitReset
                  guildId={guildId}
                  kind="standalone"
                  id={d.id}
                  onReset={afterReset('standalone', d)}
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
