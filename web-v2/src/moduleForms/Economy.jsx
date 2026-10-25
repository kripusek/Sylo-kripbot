import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, adjustEconomyBalance, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';
import ChipPicker from '../components/ChipPicker.jsx';

const MAX_DAYS = 31;

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

// The form keeps a stable `key` on every editable row so React can track rows as
// they are added and removed; the keys are stripped again before saving.
function toForm(config) {
  return {
    ...config,
    daily: { ...config.daily, rewards: config.daily.rewards.map((amount) => ({ key: newKey(), amount })) },
    levelRewards: {
      ...config.levelRewards,
      milestones: config.levelRewards.milestones.map((m) => ({ key: newKey(), ...m })),
    },
    shop: { ...config.shop, items: config.shop.items.map((i) => ({ key: newKey(), ...i })) },
  };
}

function toPayload(form) {
  return {
    ...form,
    daily: { ...form.daily, rewards: form.daily.rewards.map((r) => r.amount) },
    levelRewards: {
      ...form.levelRewards,
      milestones: form.levelRewards.milestones.map(({ level, amount }) => ({ level, amount })),
    },
    shop: { ...form.shop, items: form.shop.items.map(({ roleId, price }) => ({ roleId, price })) },
  };
}

export default function Economy() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'economy'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [top, setTop] = useState([]);
  const [adjust, setAdjust] = useState({ userId: '', amount: '' });
  const [adjustMsg, setAdjustMsg] = useState(null);

  useEffect(() => {
    if (data) {
      setForm(toForm(data.config));
      setTop(data.top ?? []);
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
          `Nie udało się wczytać ustawień ekonomii (${error.message}).`
        )}
      </p>
    );
  }

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setSection = (section, patch) => setForm((f) => ({ ...f, [section]: { ...f[section], ...patch } }));
  const setCs2 = (patch) => setSection('games', { cs2: { ...(form.games.cs2 ?? {}), ...patch } });
  const num = (value) => (value === '' ? '' : Number(value));

  const { daily, levelRewards, transfers, shop, games, activity } = form;
  const setActivity = (kind, patch) =>
    setForm((f) => ({ ...f, activity: { ...f.activity, [kind]: { ...f.activity[kind], ...patch } } }));

  async function onAdjust(action) {
    setAdjustMsg(null);
    try {
      const r = await adjustEconomyBalance(guildId, adjust.userId, action, Number(adjust.amount));
      setTop(r.top);
      setAdjustMsg({ ok: true, text: `Gotowe — nowe saldo: ${r.balance.toLocaleString('pl-PL')}.` });
    } catch (err) {
      setAdjustMsg({ ok: false, text: err.message });
    }
  }
  const updateRow = (section, list, key, patch) =>
    setSection(section, { [list]: form[section][list].map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const removeRow = (section, list, key) =>
    setSection(section, { [list]: form[section][list].filter((r) => r.key !== key) });

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const { config } = await saveModuleConfig(guildId, 'economy', toPayload(form));
      setForm(toForm(config));
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Ekonomia</h1>
      <p className="v2-field-hint">
        Wirtualne monety zdobywane za dzienną nagrodę i awans na kolejny poziom, wydawane na role, przelewy i
        gry. Monety nie mają realnej wartości i nie można ich kupić ani wypłacić.
      </p>

      <form onSubmit={onSave}>
        <div className="v2-group">
          <h2 className="v2-group-title">Waluta</h2>
          <div className="v2-field">
            <label htmlFor="currencyName">Nazwa waluty</label>
            <input
              id="currencyName"
              maxLength={24}
              value={form.currencyName}
              onChange={(e) => set({ currencyName: e.target.value })}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="currencyEmoji">Emoji waluty</label>
            <input
              id="currencyEmoji"
              maxLength={40}
              style={{ maxWidth: '120px' }}
              value={form.currencyEmoji}
              onChange={(e) => set({ currencyEmoji: e.target.value })}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="startingBalance">Saldo początkowe</label>
            <input
              id="startingBalance"
              type="number"
              min={0}
              max={1000000}
              style={{ maxWidth: '140px' }}
              value={form.startingBalance}
              onChange={(e) => set({ startingBalance: num(e.target.value) })}
            />
          </div>
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">Dzienne nagrody</h2>
          <p className="v2-field-hint">
            Członkowie odbierają nagrodę komendą <code>/ekonomia daily</code>. Odbiór w kolejnych dniach
            buduje passę i przesuwa ich po poniższych dniach.
          </p>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={daily.enabled}
                onChange={(e) => setSection('daily', { enabled: e.target.checked })}
              />
              Włącz dzienne nagrody
            </label>
          </div>
          <div className="v2-field">
            <label htmlFor="dailyCooldown">Godzin między odbiorami</label>
            <input
              id="dailyCooldown"
              type="number"
              min={1}
              max={168}
              style={{ maxWidth: '120px' }}
              value={daily.cooldownHours}
              onChange={(e) => setSection('daily', { cooldownHours: num(e.target.value) })}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="dailyGrace">Dodatkowe godziny na utrzymanie passy</label>
            <input
              id="dailyGrace"
              type="number"
              min={0}
              max={168}
              style={{ maxWidth: '120px' }}
              value={daily.graceHours}
              onChange={(e) => setSection('daily', { graceHours: num(e.target.value) })}
            />
            <p className="v2-field-hint">
              Jeśli członek odbierze nagrodę później niż odstęp plus te godziny, passa wraca do dnia 1.
            </p>
          </div>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={daily.loop}
                onChange={(e) => setSection('daily', { loop: e.target.checked })}
              />
              Po ostatnim dniu zacznij od dnia 1
            </label>
          </div>

          <label>Nagroda za każdy dzień</label>
          {daily.rewards.map((r, i) => (
            <div className="v2-field-row" key={r.key}>
              <span style={{ minWidth: '64px' }}>Dzień {i + 1}</span>
              <input
                type="number"
                min={0}
                max={1000000000}
                style={{ maxWidth: '140px' }}
                aria-label={`Nagroda za dzień ${i + 1}`}
                value={r.amount}
                onChange={(e) => updateRow('daily', 'rewards', r.key, { amount: num(e.target.value) })}
              />
              <button
                type="button"
                className="v2-btn-ghost"
                disabled={daily.rewards.length <= 1}
                onClick={() => removeRow('daily', 'rewards', r.key)}
              >
                usuń
              </button>
            </div>
          ))}
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={daily.rewards.length >= MAX_DAYS}
            onClick={() =>
              setSection('daily', {
                rewards: [...daily.rewards, { key: newKey(), amount: daily.rewards.at(-1)?.amount ?? 100 }],
              })
            }
          >
            + Dodaj dzień
          </button>
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">Nagrody za poziomy</h2>
          <p className="v2-field-hint">
            Wypłata monet za każdy nowy poziom. Wymaga włączonego modułu Poziomy (Leveling).
          </p>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={levelRewards.enabled}
                onChange={(e) => setSection('levelRewards', { enabled: e.target.checked })}
              />
              Wypłacaj monety za awans na kolejny poziom
            </label>
          </div>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="radio"
                name="levelMode"
                checked={levelRewards.mode === 'flat'}
                onChange={() => setSection('levelRewards', { mode: 'flat' })}
              />
              Stała kwota za każdy poziom
            </label>
            <label className="v2-check">
              <input
                type="radio"
                name="levelMode"
                checked={levelRewards.mode === 'scaled'}
                onChange={() => setSection('levelRewards', { mode: 'scaled' })}
              />
              Kwota pomnożona przez osiągnięty poziom
            </label>
          </div>
          <div className="v2-field">
            <label htmlFor="levelAmount">Monet za poziom</label>
            <input
              id="levelAmount"
              type="number"
              min={0}
              max={1000000000}
              style={{ maxWidth: '140px' }}
              value={levelRewards.amount}
              onChange={(e) => setSection('levelRewards', { amount: num(e.target.value) })}
            />
          </div>

          <label>Premia na wybranych poziomach</label>
          {levelRewards.milestones.map((m) => (
            <div className="v2-field-row" key={m.key}>
              <span>Na poziomie</span>
              <input
                type="number"
                min={1}
                max={1000}
                style={{ maxWidth: '90px' }}
                aria-label="Poziom"
                value={m.level}
                onChange={(e) =>
                  updateRow('levelRewards', 'milestones', m.key, { level: num(e.target.value) })
                }
              />
              <span>dodatkowo</span>
              <input
                type="number"
                min={1}
                max={1000000000}
                style={{ maxWidth: '140px' }}
                aria-label="Dodatkowe monety"
                value={m.amount}
                onChange={(e) =>
                  updateRow('levelRewards', 'milestones', m.key, { amount: num(e.target.value) })
                }
              />
              <button
                type="button"
                className="v2-btn-ghost"
                onClick={() => removeRow('levelRewards', 'milestones', m.key)}
              >
                usuń
              </button>
            </div>
          ))}
          <button
            type="button"
            className="v2-btn-ghost"
            onClick={() =>
              setSection('levelRewards', {
                milestones: [...levelRewards.milestones, { key: newKey(), level: 10, amount: 500 }],
              })
            }
          >
            + Dodaj premię za poziom
          </button>

          <div className="v2-field v2-section-gap">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={levelRewards.notify}
                onChange={(e) => setSection('levelRewards', { notify: e.target.checked })}
              />
              Wyślij krótką wiadomość po wypłacie monet
            </label>
          </div>
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">Przelewy</h2>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={transfers.enabled}
                onChange={(e) => setSection('transfers', { enabled: e.target.checked })}
              />
              Pozwól wysyłać monety komendą <code>/ekonomia przekaz</code>
            </label>
          </div>
          <div className="v2-field">
            <label htmlFor="transferMin">Minimalna kwota przelewu</label>
            <input
              id="transferMin"
              type="number"
              min={1}
              max={1000000000}
              style={{ maxWidth: '140px' }}
              value={transfers.minAmount}
              onChange={(e) => setSection('transfers', { minAmount: num(e.target.value) })}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="transferFee">Prowizja od przelewu (%)</label>
            <input
              id="transferFee"
              type="number"
              min={0}
              max={50}
              style={{ maxWidth: '120px' }}
              value={transfers.feePercent}
              onChange={(e) => setSection('transfers', { feePercent: num(e.target.value) })}
            />
          </div>
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">Sklep z rolami</h2>
          <p className="v2-field-hint">
            Członkowie kupują te role komendą <code>/kup rola</code>. Bot potrzebuje uprawnienia Zarządzanie
            rolami, a jego rola musi być wyżej niż sprzedawane role.
          </p>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={shop.enabled}
                onChange={(e) => setSection('shop', { enabled: e.target.checked })}
              />
              Włącz sklep
            </label>
          </div>
          {shop.items.map((item) => (
            <div className="v2-field-row" key={item.key}>
              <select
                value={item.roleId}
                aria-label="Rola"
                onChange={(e) => updateRow('shop', 'items', item.key, { roleId: e.target.value })}
              >
                <option value="">— wybierz rolę —</option>
                {data.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                max={1000000000}
                style={{ maxWidth: '140px' }}
                aria-label="Cena"
                value={item.price}
                onChange={(e) => updateRow('shop', 'items', item.key, { price: num(e.target.value) })}
              />
              <button
                type="button"
                className="v2-btn-ghost"
                onClick={() => removeRow('shop', 'items', item.key)}
              >
                usuń
              </button>
            </div>
          ))}
          <button
            type="button"
            className="v2-btn-ghost"
            onClick={() =>
              setSection('shop', { items: [...shop.items, { key: newKey(), roleId: '', price: 1000 }] })
            }
          >
            + Dodaj rolę
          </button>
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">Nagrody za aktywność</h2>
          <p className="v2-field-hint">
            Monety za samą obecność. Każde źródło ma opcjonalny dzienny limit na członka (0 = bez limitu).
          </p>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={activity.messages.enabled}
                onChange={(e) => setActivity('messages', { enabled: e.target.checked })}
              />
              Monety za pisanie na czacie
            </label>
          </div>
          <div className="v2-field">
            <label htmlFor="msgAmount">Monet za wypłatę</label>
            <input
              id="msgAmount"
              type="number"
              min={1}
              max={100000}
              style={{ maxWidth: '140px' }}
              value={activity.messages.amount}
              onChange={(e) => setActivity('messages', { amount: num(e.target.value) })}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="msgCooldown">Sekund między wypłatami</label>
            <input
              id="msgCooldown"
              type="number"
              min={5}
              max={3600}
              style={{ maxWidth: '140px' }}
              value={activity.messages.cooldownSeconds}
              onChange={(e) => setActivity('messages', { cooldownSeconds: num(e.target.value) })}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="msgCap">Dzienny limit z pisania</label>
            <input
              id="msgCap"
              type="number"
              min={0}
              max={1000000000}
              style={{ maxWidth: '140px' }}
              value={activity.messages.dailyCap}
              onChange={(e) => setActivity('messages', { dailyCap: num(e.target.value) })}
            />
          </div>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={activity.voice.enabled}
                onChange={(e) => setActivity('voice', { enabled: e.target.checked })}
              />
              Monety za czas na kanałach głosowych
            </label>
          </div>
          <div className="v2-field">
            <label htmlFor="voiceRate">Monet na minutę</label>
            <input
              id="voiceRate"
              type="number"
              min={1}
              max={100000}
              style={{ maxWidth: '140px' }}
              value={activity.voice.perMinute}
              onChange={(e) => setActivity('voice', { perMinute: num(e.target.value) })}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="voiceCap">Dzienny limit z głosowego</label>
            <input
              id="voiceCap"
              type="number"
              min={0}
              max={1000000000}
              style={{ maxWidth: '140px' }}
              value={activity.voice.dailyCap}
              onChange={(e) => setActivity('voice', { dailyCap: num(e.target.value) })}
            />
            <p className="v2-field-hint">
              Czas na głosowym liczy się, gdy członek nie jest sam, nie ma wyciszonego słuchania i nie jest na
              kanale AFK. Dzienne limity zerują się po restarcie bota.
            </p>
          </div>
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">Gry</h2>
          <p className="v2-field-hint">
            Gry za wirtualne monety pod <code>/gry</code>: coinflip, zgadnij, kamień-papier-nożyce, kostka,
            sloty, blackjack, poker, ruletka i kubki.
          </p>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={games.enabled}
                onChange={(e) => setSection('games', { enabled: e.target.checked })}
              />
              Włącz gry
            </label>
          </div>
          <div className="v2-field">
            <label htmlFor="minBet">Minimalna stawka</label>
            <input
              id="minBet"
              type="number"
              min={1}
              max={1000000000}
              style={{ maxWidth: '140px' }}
              value={games.minBet}
              onChange={(e) => setSection('games', { minBet: num(e.target.value) })}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="maxBet">Maksymalna stawka</label>
            <input
              id="maxBet"
              type="number"
              min={1}
              max={1000000000}
              style={{ maxWidth: '140px' }}
              value={games.maxBet}
              onChange={(e) => setSection('games', { maxBet: num(e.target.value) })}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="gameCooldown">Sekund przerwy między grami</label>
            <input
              id="gameCooldown"
              type="number"
              min={0}
              max={600}
              style={{ maxWidth: '120px' }}
              value={games.cooldownSeconds}
              onChange={(e) => setSection('games', { cooldownSeconds: num(e.target.value) })}
            />
          </div>
          <div className="v2-field">
            <label>Tylko na tych kanałach</label>
            <ChipPicker
              kind="channel"
              items={data.channels}
              value={games.channelIds}
              onChange={(channelIds) => setSection('games', { channelIds })}
            />
            <p className="v2-field-hint">Zostaw puste, aby pozwolić na gry na każdym kanale.</p>
          </div>
          <h3 className="v2-section-gap-sm">Zakłady CS2 — ogłoszenia wyników</h3>
          <p className="v2-field-hint">
            Gdzie i jak ogłaszany jest wynik stawki z <code>/gry cs2</code>. Pusta wiadomość = domyślna.
            Znaczniki: {'{user} {amount} {payout} {multiplier} {map} {score} {mode} {currency}'}.
          </p>
          <div className="v2-field">
            <label htmlFor="cs2Channel">Kanał ogłoszeń</label>
            <select
              id="cs2Channel"
              value={games.cs2?.channelId ?? ''}
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
                checked={games.cs2?.ping !== false}
                onChange={(e) => setCs2({ ping: e.target.checked })}
              />
              Pinguj gracza (powiadomienie)
            </label>
          </div>
          <div className="v2-field">
            <label htmlFor="cs2NoPing">Rola „bez pingów”</label>
            <select
              id="cs2NoPing"
              value={games.cs2?.noPingRoleId ?? ''}
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
              Po wybraniu roli każde ogłoszenie ma przycisk; kliknięcie nadaje lub zabiera rolę, a osoby z
              rolą nie są pingowane. Bot potrzebuje „Zarządzanie rolami”, a rola musi być pod jego najwyższą rolą.
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
                value={games.cs2?.[key] ?? ''}
                onChange={(e) => setCs2({ [key]: e.target.value })}
              />
            </div>
          ))}
        </div>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Zapisywanie…' : 'Zapisz ustawienia ekonomii'}
          </button>
          {saved ? <span className="v2-field-hint"> Zapisano.</span> : null}
        </div>
      </form>
      <div className="v2-group">
        <h2 className="v2-group-title">Zarządzaj monetami</h2>
        <p className="v2-field-hint">
          Dodaj, odejmij lub ustaw saldo członka ręcznie — przydatne do testów. Zmiany trafiają do dziennika
          audytu.
        </p>
        <div className="v2-field">
          <label htmlFor="adjUser">ID członka lub @wzmianka</label>
          <input
            id="adjUser"
            value={adjust.userId}
            onChange={(e) => setAdjust((a) => ({ ...a, userId: e.target.value }))}
          />
        </div>
        <div className="v2-field">
          <label htmlFor="adjAmount">Kwota</label>
          <input
            id="adjAmount"
            type="number"
            min={0}
            max={1000000000}
            style={{ maxWidth: '160px' }}
            value={adjust.amount}
            onChange={(e) => setAdjust((a) => ({ ...a, amount: e.target.value }))}
          />
        </div>
        <div className="v2-section-gap">
          <button type="button" className="v2-btn-primary" onClick={() => onAdjust('add')}>
            Dodaj
          </button>{' '}
          <button type="button" className="v2-btn-ghost" onClick={() => onAdjust('remove')}>
            Odejmij
          </button>{' '}
          <button
            type="button"
            className="v2-btn-ghost"
            onClick={() => {
              if (window.confirm('Zastąpić saldo tego członka podaną kwotą?')) onAdjust('set');
            }}
          >
            Ustaw saldo
          </button>
          {adjustMsg ? (
            <p className="v2-field-hint" role="status">
              {adjustMsg.text}
            </p>
          ) : null}
        </div>
      </div>

      <div className="v2-group">
        <h2 className="v2-group-title">Najbogatsi</h2>
        {top.length ? (
          <table className="v2-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Członek</th>
                <th>Monety</th>
              </tr>
            </thead>
            <tbody>
              {top.map((row) => (
                <tr key={row.userId}>
                  <td>{row.rank}</td>
                  <td>{row.name}</td>
                  <td>
                    {row.balance.toLocaleString('pl-PL')} {form.currencyEmoji}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="v2-field-hint">Nikt jeszcze nie ma monet.</p>
        )}
      </div>
    </>
  );
}
