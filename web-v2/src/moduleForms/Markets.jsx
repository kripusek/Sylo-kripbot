import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, getTrendingMarkets, marketsApi, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

const statusText = (m) => {
  if (m.status === 'resolved') return `Rozstrzygnięty: ${m.options[m.winner]?.label ?? '—'}`;
  if (m.status === 'cancelled') return 'Anulowany';
  if (m.closesAt && m.closesAt <= Date.now()) return 'Zakłady zamknięte — czeka na wynik';
  return 'Otwarty';
};

function Market({ guildId, market, channelName, defaultChannel, run, busy }) {
  const [winner, setWinner] = useState('');
  const open = market.status === 'open';
  return (
    <div className="v2-card" style={{ marginBottom: 12 }}>
      <strong>
        #{market.id} {market.question}
      </strong>
      <span className="v2-field-hint"> · {market.source === 'polymarket' ? 'Polymarket' : 'własny'}</span>
      <div className="v2-field-hint">
        {statusText(market)} · pula {market.total} ·{' '}
        {market.published ? channelName(market.channelId) : 'nieopublikowany'}
      </div>
      <ul>
        {market.options.map((o, i) => (
          <li key={i}>
            {market.status === 'resolved' && market.winner === i ? '✅ ' : ''}
            {o.label} — {o.total} ({o.share}%, {o.bets} zakł.)
            {o.percent !== null ? ` · Polymarket ${o.percent}%` : ''}
          </li>
        ))}
      </ul>
      {open ? (
        <div className="v2-field-row">
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  marketsApi(guildId, `/${market.id}/publish`, {
                    channelId: market.channelId || defaultChannel,
                  }),
                market.published ? 'Wiadomość odświeżona.' : 'Rynek opublikowany.'
              )
            }
          >
            {market.published ? 'Odśwież wiadomość' : 'Opublikuj'}
          </button>
          <select value={winner} onChange={(e) => setWinner(e.target.value)} aria-label="Zwycięska opcja">
            <option value="">Zwycięska opcja…</option>
            {market.options.map((o, i) => (
              <option key={i} value={i}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="v2-btn-primary"
            disabled={busy || winner === ''}
            onClick={() => {
              if (!window.confirm('Rozstrzygnąć rynek? Wypłaty ruszą od razu i nie da się tego cofnąć.'))
                return;
              run(
                () => marketsApi(guildId, `/${market.id}/settle`, { winner: Number(winner) }),
                'Rynek rozstrzygnięty, wypłaty zrobione.'
              );
            }}
          >
            Rozstrzygnij
          </button>
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Anulować rynek i zwrócić wszystkim zakłady?')) return;
              run(() => marketsApi(guildId, `/${market.id}/cancel`), 'Rynek anulowany, zakłady zwrócone.');
            }}
          >
            Anuluj i zwróć
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="v2-btn-ghost"
          disabled={busy}
          onClick={() => {
            if (!window.confirm('Usunąć rynek z historii?')) return;
            run(() => marketsApi(guildId, `/${market.id}/delete`), 'Rynek usunięty.');
          }}
        >
          Usuń z historii
        </button>
      )}
    </div>
  );
}

export default function Markets() {
  const { guildId } = useParams();
  // Bumping `tick` re-fetches after every change (useApiData has no reload of its own).
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'markets'), [guildId, tick]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({
    question: '',
    description: '',
    options: '',
    closes: '',
    channelId: '',
    publish: true,
  });
  const [cs, setCs] = useState({ steamId: '', name: '', closes: '' });
  const [importUrl, setImportUrl] = useState('');
  const [trending, setTrending] = useState(null);

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
          `Couldn't load Rynki (${error.message}).`
        )}
      </p>
    );
  }

  const cfg = settings ?? data.config;
  const channelName = (id) => {
    const c = data.channels.find((x) => x.id === id);
    return c ? `#${c.name}` : '—';
  };
  const channelId = form.channelId || cfg.channelId;

  async function run(fn, okText) {
    setBusy(true);
    setMsg(null);
    try {
      const out = await fn();
      reload();
      setMsg({ bad: Boolean(out?.warning), text: out?.warning || okText });
      return out;
    } catch (err) {
      setMsg({ bad: true, text: err.message });
      return null;
    } finally {
      setBusy(false);
    }
  }

  const closesMs = () => {
    if (!form.closes) return 0;
    const t = new Date(form.closes).getTime();
    return Number.isNaN(t) ? 0 : t;
  };

  return (
    <div>
      <p className="v2-field-hint">
        Rynki predykcyjne na wirtualne monety z modułu Ekonomia (bez prawdziwych pieniędzy). Po
        rozstrzygnięciu cała pula dzieli się między tych, którzy trafili, proporcjonalnie do stawek. Jeśli
        nikt nie trafił albo rynek anulujesz, wszyscy odzyskują monety. Rynki z Polymarketa same aktualizują
        procenty i rozliczają się, gdy Polymarket poda wynik (sprawdzanie co 5 minut); własne rozstrzygasz
        ręcznie. Wymaga włączonego modułu Ekonomia.
      </p>
      {msg ? (
        <p className="v2-field-hint" style={msg.bad ? { color: 'var(--bad, #ed4245)' } : undefined}>
          {msg.text}
        </p>
      ) : null}

      <h2 className="v2-group-title">Ustawienia zakładów</h2>
      <div className="v2-field-row">
        <label>
          Minimalna stawka{' '}
          <input
            type="number"
            min="1"
            value={cfg.minBet}
            onChange={(e) => setSettings({ ...cfg, minBet: e.target.value })}
          />
        </label>
        <label>
          Maksymalna stawka{' '}
          <input
            type="number"
            min="1"
            value={cfg.maxBet}
            onChange={(e) => setSettings({ ...cfg, maxBet: e.target.value })}
          />
        </label>
        <label>
          Domyślny kanał{' '}
          <select value={cfg.channelId} onChange={(e) => setSettings({ ...cfg, channelId: e.target.value })}>
            <option value="">— wybierz —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="v2-btn-primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const out = await marketsApi(guildId, '/settings', cfg);
              setSettings(null);
              return out;
            }, 'Ustawienia zapisane.')
          }
        >
          Zapisz ustawienia
        </button>
      </div>

      <h2 className="v2-group-title">Nowy własny rynek</h2>
      <div className="v2-field">
        <input
          style={{ width: '100%', maxWidth: 520 }}
          maxLength={200}
          placeholder="Pytanie, np. Kto wygra mecz?"
          value={form.question}
          onChange={(e) => setForm({ ...form, question: e.target.value })}
        />
        <textarea
          style={{ width: '100%', maxWidth: 520 }}
          rows={2}
          maxLength={800}
          placeholder="Opis (opcjonalnie)"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <textarea
          style={{ width: '100%', maxWidth: 520 }}
          rows={4}
          placeholder={'Opcje — jedna w linii (od 2 do 10)\nDrużyna A\nDrużyna B'}
          value={form.options}
          onChange={(e) => setForm({ ...form, options: e.target.value })}
        />
      </div>
      <div className="v2-field-row">
        <label>
          Zakłady do{' '}
          <input
            type="datetime-local"
            value={form.closes}
            onChange={(e) => setForm({ ...form, closes: e.target.value })}
          />
        </label>
        <label>
          Kanał{' '}
          <select value={form.channelId} onChange={(e) => setForm({ ...form, channelId: e.target.value })}>
            <option value="">
              {cfg.channelId ? `domyślny (${channelName(cfg.channelId)})` : '— wybierz —'}
            </option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.publish}
            onChange={(e) => setForm({ ...form, publish: e.target.checked })}
          />{' '}
          Od razu opublikuj
        </label>
        <button
          type="button"
          className="v2-btn-primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const out = await marketsApi(guildId, '/create', {
                question: form.question,
                description: form.description,
                options: form.options,
                closesAt: closesMs(),
                channelId,
                publish: form.publish,
              });
              setForm({ ...form, question: '', description: '', options: '', closes: '' });
              return out;
            }, 'Rynek utworzony.')
          }
        >
          Utwórz rynek
        </button>
      </div>

      <h2 className="v2-group-title">Mecz CS2 (rozliczany z Leetify)</h2>
      <p className="v2-field-hint">
        Rynek „Czy gracz wygra następny mecz CS2?”. Liczy się pierwszy mecz zakończony po zamknięciu zakładów;
        remis zwraca stawki. Bot sprawdza wyniki co 5 minut w Leetify (dane pojawiają się po przetworzeniu
        meczu, czasem z opóźnieniem). Dane: Leetify.
      </p>
      {data.leetify === false ? (
        <p className="v2-field-hint" style={{ color: 'var(--bad, #ed4245)' }}>
          Brak klucza LEETIFY_API_KEY na serwerze bota — rynek utworzysz, ale rozstrzygniesz go ręcznie.
        </p>
      ) : null}
      <div className="v2-field-row">
        <input
          style={{ width: '100%', maxWidth: 360 }}
          placeholder="SteamID64 lub link steamcommunity.com/profiles/…"
          value={cs.steamId}
          onChange={(e) => setCs({ ...cs, steamId: e.target.value })}
        />
        <input
          maxLength={40}
          placeholder="Nick w pytaniu"
          value={cs.name}
          onChange={(e) => setCs({ ...cs, name: e.target.value })}
        />
        <label>
          Zakłady do{' '}
          <input
            type="datetime-local"
            value={cs.closes}
            onChange={(e) => setCs({ ...cs, closes: e.target.value })}
          />
        </label>
        <button
          type="button"
          className="v2-btn-primary"
          disabled={busy || !cs.steamId.trim()}
          onClick={() =>
            run(async () => {
              const t = cs.closes ? new Date(cs.closes).getTime() : 0;
              const out = await marketsApi(guildId, '/create-cs2', {
                steamId: cs.steamId,
                name: cs.name,
                closesAt: Number.isNaN(t) ? 0 : t,
                channelId,
                publish: form.publish,
              });
              setCs({ ...cs, steamId: '', closes: '' });
              return out;
            }, 'Rynek meczu CS2 utworzony.')
          }
        >
          Utwórz rynek meczu
        </button>
      </div>

      <h2 className="v2-group-title">Import z Polymarketa</h2>
      <p className="v2-field-hint">
        Wklej adres rynku z polymarket.com albo wybierz z najpopularniejszych. Opcje i procenty przychodzą z
        Polymarketa; zakłady są tylko na wirtualne monety.
      </p>
      <div className="v2-field-row">
        <input
          style={{ width: '100%', maxWidth: 520 }}
          placeholder="https://polymarket.com/event/…"
          value={importUrl}
          onChange={(e) => setImportUrl(e.target.value)}
        />
        <button
          type="button"
          className="v2-btn-primary"
          disabled={busy || !importUrl.trim()}
          onClick={() =>
            run(async () => {
              const out = await marketsApi(guildId, '/import', {
                input: importUrl,
                channelId,
                publish: form.publish,
              });
              setImportUrl('');
              return out;
            }, 'Rynek zaimportowany z Polymarketa.')
          }
        >
          Importuj
        </button>
        <button
          type="button"
          className="v2-btn-ghost"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              setTrending((await getTrendingMarkets(guildId)).events);
            } catch (err) {
              setMsg({ bad: true, text: err.message });
            } finally {
              setBusy(false);
            }
          }}
        >
          Pokaż popularne
        </button>
      </div>
      {trending ? (
        <ul>
          {trending.map((e) => (
            <li key={e.slug}>
              <strong>{e.question}</strong>{' '}
              <span className="v2-field-hint">
                {e.options.map((o) => `${o.label}${o.percent === null ? '' : ` ${o.percent}%`}`).join(' · ')}
              </span>{' '}
              <button
                type="button"
                className="v2-btn-ghost"
                disabled={busy}
                onClick={() =>
                  run(
                    () => marketsApi(guildId, '/import', { input: e.slug, channelId, publish: form.publish }),
                    'Rynek zaimportowany z Polymarketa.'
                  )
                }
              >
                Importuj
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <h2 className="v2-group-title">Rynki</h2>
      {data.markets.length === 0 ? <p className="v2-state">Nie ma jeszcze żadnych rynków.</p> : null}
      {data.markets.map((m) => (
        <Market
          key={m.id}
          guildId={guildId}
          market={m}
          channelName={channelName}
          defaultChannel={cfg.channelId}
          run={run}
          busy={busy}
        />
      ))}
    </div>
  );
}
