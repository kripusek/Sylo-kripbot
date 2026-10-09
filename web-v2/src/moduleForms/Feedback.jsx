import ChipPicker from '../components/ChipPicker.jsx';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig } from '../api.js';
import { useApiData } from '../useApiData.js';

export default function Feedback() {
  const { guildId } = useParams();
  const { data, error } = useApiData(() => getModuleConfig(guildId, 'feedback'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (data) setForm(data.config);
  }, [data]);
  if (error) return <p className="v2-state">Could not load feedback settings: {error.message}</p>;
  if (!form) return <p className="v2-state">Loading…</p>;
  const set = (patch) => setForm((old) => ({ ...old, ...patch }));
  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setNotice('');
    try {
      const result = await saveModuleConfig(guildId, 'feedback', {
        ...form,
        action: event.nativeEvent.submitter?.value,
      });
      setForm(result.config);
      setNotice('Saved.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <h1 className="v2-section-title">Complaints &amp; feedback</h1>
      <p className="v2-field-hint">
        A button opens a complaint or feedback form. Restrict the review channel to staff in Discord.
      </p>
      <form onSubmit={save}>
        {[
          ['panelChannel', 'Panel channel'],
          ['reviewChannel', 'Staff review channel'],
        ].map(([key, label]) => (
          <div className="v2-field" key={key}>
            <label htmlFor={key}>{label}</label>
            <select id={key} value={form[key]} onChange={(event) => set({ [key]: event.target.value })}>
              <option value="">— none —</option>
              {data.channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  #{channel.name}
                </option>
              ))}
            </select>
          </div>
        ))}
        <div className="v2-field">
          <label>Roles shown in member picker</label>
          <ChipPicker
            kind="role"
            items={data.roles}
            value={form.subjectRoles || []}
            onChange={(subjectRoles) => set({ subjectRoles })}
          />
          <p className="v2-field-hint">
            Members choose a person with any selected role. Leave empty for general feedback. Server Members
            Intent is required to list all eligible members.
          </p>
        </div>
        <div className="v2-field">
          <label htmlFor="title">Panel title</label>
          <input
            id="title"
            maxLength={256}
            value={form.title}
            onChange={(event) => set({ title: event.target.value })}
          />
        </div>
        <div className="v2-field">
          <label htmlFor="message">Panel message</label>
          <textarea
            id="message"
            maxLength={2000}
            rows={4}
            value={form.message}
            onChange={(event) => set({ message: event.target.value })}
          />
        </div>
        <div className="v2-field">
          <label htmlFor="buttonLabel">Button label</label>
          <input
            id="buttonLabel"
            maxLength={80}
            value={form.buttonLabel}
            onChange={(event) => set({ buttonLabel: event.target.value })}
          />
        </div>
        <label className="v2-check">
          <input
            type="checkbox"
            checked={form.anonymous}
            onChange={(event) => set({ anonymous: event.target.checked })}
          />
          Anonymous submissions
        </label>
        <p className="v2-field-hint">
          Off by default: staff see the author's Discord username and ID. Anonymous mode omits their identity
          from the submission. One submission per minute. Text is sent to Discord, not stored in the bot
          database.
        </p>
        <button type="submit" disabled={saving}>
          Save
        </button>{' '}
        <button type="submit" value="publish" disabled={saving}>
          Save and publish panel
        </button>
        <p className="v2-field-hint">{notice}</p>
      </form>
    </>
  );
}
