import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
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

  useEffect(() => {
    if (data) setForm(toForm(data.config));
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
  const num = (value) => (value === '' ? '' : Number(value));

  const { daily, levelRewards, transfers, shop, games } = form;
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
        </div>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Zapisywanie…' : 'Zapisz ustawienia ekonomii'}
          </button>
          {saved ? <span className="v2-field-hint"> Zapisano.</span> : null}
        </div>
      </form>
    </>
  );
}
