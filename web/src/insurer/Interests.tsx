import { useEffect, useState } from 'react';
import { api, ApiError, kes, when } from '../staff/api';

interface Interest {
  id: string;
  status: 'new' | 'contacted' | 'closed';
  plan: { code: string; name: string };
  phone: string;
  householdSize: number;
  county: string | null;
  quotedMonthlyMinor: string;
  note: string | null;
  createdAt: string;
}

const FILTERS = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'closed', label: 'Closed' },
] as const;

/** Customers who asked to be contacted about one of your plans, and agreed to share their phone number with you. */
export function Interests({ canAct }: { canAct: boolean }) {
  const [filter, setFilter] = useState<string>('new');
  const [rows, setRows] = useState<Interest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = () => api<Interest[]>(`/insurer/plan-interests?status=${filter}`).then(setRows).catch((e: ApiError) => setError(e.message));
  useEffect(() => {
    setRows(null);
    load();
  }, [filter]);

  return (
    <>
      <div className="row-between">
        <h1>Interested customers</h1>
        <div className="seg" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => { setFilter(f.value); setFlash(null); }}>{f.label}</button>
          ))}
        </div>
      </div>
      <p className="muted">Each customer agreed to share their phone number, household size and county with you about this plan. They have not bought anything and have no cover from this.</p>
      {flash && <p className="ok" role="status">{flash}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!rows ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="card empty muted">Nothing here.</p>
      ) : (
        <div className="table-wrap" role="region" aria-label="Results" tabIndex={0}>
        <table className="grid">
          <thead>
            <tr><th>Asked</th><th>Plan</th><th>Phone</th><th>People</th><th>County</th><th className="num">Listed price</th><th>Note</th>{canAct && filter !== 'closed' && <th><span className="sr-only">Actions</span></th>}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <InterestRow key={r.id} row={r} canAct={canAct && filter !== 'closed'} done={(m) => { setFlash(m); load(); }} />
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}

function InterestRow({ row: r, canAct, done }: { row: Interest; canAct: boolean; done: (m: string) => void }) {
  const [note, setNote] = useState(r.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function move(status: 'contacted' | 'closed') {
    setBusy(true);
    setError(null);
    try {
      await api(`/insurer/plan-interests/${r.id}/status`, { method: 'POST', body: { status, note: note.trim() || undefined } });
      done(`${r.phone} marked ${status}.`);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>{when(r.createdAt)}</td>
      <td>{r.plan.name}</td>
      <td className="mono"><a href={`tel:${r.phone}`}>{r.phone}</a></td>
      <td>{r.householdSize}</td>
      <td>{r.county ?? '—'}</td>
      <td className="num">{kes(r.quotedMonthlyMinor)}/month</td>
      <td>
        {canAct ? <input aria-label={`Note for ${r.phone}`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /> : r.note ?? '—'}
        {error && <p className="error" role="alert">{error}</p>}
      </td>
      {canAct && (
        <td className="actions">
          {r.status === 'new' && <button className="secondary small" disabled={busy} onClick={() => move('contacted')}>Contacted</button>}
          <button className="secondary small" disabled={busy} onClick={() => move('closed')}>Close</button>
        </td>
      )}
    </tr>
  );
}
