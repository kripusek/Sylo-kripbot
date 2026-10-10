// Multi-select replacement for a native <select multiple> (which needs
// ctrl/cmd-click to pick more than one — not discoverable, flagged by the
// user). Selected items render as removable chips; a plain single-select
// dropdown adds more. Ports V1's chip-picker.ejs/chipPicker Alpine
// component to React with the same interaction shape.
import { useState } from 'react';

export default function ChipPicker({ items, value, onChange, kind = 'role', placeholder }) {
  const [query, setQuery] = useState('');
  const selected = [...new Set((value || []).map(String))];
  const selectedItems = selected.map((id) => items.find((i) => String(i.id) === id) || { id, name: id });
  const available = items.filter((i) => !selected.includes(String(i.id)));
  const needle = query.trim().toLocaleLowerCase();
  const filtered = available.filter(
    (i) => i.name.toLocaleLowerCase().includes(needle) || String(i.id).includes(needle)
  );
  const defaultPlaceholder = kind === 'channel' ? 'Wybierz kanał z listy…' : 'Wybierz rolę z listy…';

  function remove(id) {
    onChange(selected.filter((v) => v !== String(id)));
  }

  function add(e) {
    const id = e.target.value;
    if (id && available.some((item) => String(item.id) === id)) onChange([...selected, id]);
    setQuery('');
    e.target.value = '';
  }

  return (
    <div className="v2-chip-picker">
      <div className="v2-chip-row">
        {selectedItems.length === 0 ? <span className="v2-field-hint">Nic nie wybrano</span> : null}
        {selectedItems.map((item) => (
          <span className="v2-chip" key={item.id}>
            {kind === 'channel' ? (
              <span className="v2-chip-hash">#</span>
            ) : (
              <span className="v2-chip-dot" style={{ background: item.color || 'var(--text-muted)' }} />
            )}
            <span>{item.name}</span>
            <button
              type="button"
              className="v2-chip-x"
              aria-label={`Usuń ${item.name}`}
              onClick={() => remove(item.id)}
            >
              &times;
            </button>
          </span>
        ))}
      </div>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Szukaj po nazwie lub ID…"
        aria-label="Wyszukaj po nazwie lub ID"
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
        }}
      />
      <select
        className="v2-chip-add"
        value=""
        onChange={add}
        disabled={!filtered.length}
        aria-label="Wybierz pozycję do dodania"
      >
        <option value="">{placeholder || defaultPlaceholder}</option>
        {filtered.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {kind === 'channel' ? '#' : ''}
            {opt.name}
          </option>
        ))}
      </select>
      {query && !filtered.length ? <span className="v2-field-hint">Brak pasujących pozycji</span> : null}
      {!query && !available.length ? (
        <span className="v2-field-hint">Wybrano wszystkie dostępne pozycje</span>
      ) : null}
    </div>
  );
}
