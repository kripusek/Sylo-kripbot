import { Link, useParams } from 'react-router-dom';
import { getModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

export default function RandomDrops() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'random-drops'), [guildId]);

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
                <td>{m.claims}</td>
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
                {d.name} — odebrano: {d.claims}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
