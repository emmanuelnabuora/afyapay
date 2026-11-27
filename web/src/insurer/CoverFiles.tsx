import { useEffect, useState } from 'react';
import { api, upload, when } from './api';
import type { Me } from './Portal';
import { ErrorLine, FilePick, Table, useAction, who } from './ui';

interface Batch {
  id: string; fileName: string; items: number; needsSecondApprover: boolean; status: 'proposed' | 'applied' | 'rejected';
  proposedBy: string; decidedBy: string | null; decisionNote: string | null; applied: number | null; failed: number | null; createdAt: string; errors?: string[];
}

const STATUS = { proposed: 'Waiting for a second approver', applied: 'Applied', rejected: 'Rejected' };

/** Cover changes for many policies at once from a file. Over 50 lines waits for a different approver. */
export function CoverFiles({ me, canAct }: { me: Me; canAct: boolean }) {
  const [rows, setRows] = useState<Batch[] | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    api<Batch[]>('/insurer/cover-batches').then(setRows).catch(() => setRows([]));
  }, [tick]);

  async function send(f: File) {
    setResult(null);
    const b = await upload<Batch>('/insurer/cover-batches', f);
    setResult(b.status === 'proposed'
      ? `${b.fileName} has ${b.items} lines, so it waits for a different person with the approver role before any cover changes.`
      : `${b.fileName}: ${b.applied ?? 0} cover changes applied${b.failed ? `, ${b.failed} lines could not be applied` : ''}.`);
    setTick(tick + 1);
  }

  return (
    <>
      <h1>Cover files</h1>
      <p className="muted">Change cover for many policies at once. Customers see each change as confirmed by your team. Payments never change cover.</p>
      {canAct && (
        <section className="card">
          <h2>Upload a cover file</h2>
          <FilePick
            id="cover-file"
            label="CSV or Excel file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hint={<>Columns: <span className="mono">policy_number, status, covered_until, effective_on, reference</span>. Status is active, lapsed or ended; dates are YYYY-MM-DD. Files over 50 lines wait for a second approver.</>}
            button="Upload"
            onSend={send}
          />
          {result && <p className="ok top-gap" role="status">{result}</p>}
        </section>
      )}
      <h2>Files</h2>
      {!rows ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="card empty muted">None yet.</p> : (
        <Table head={<tr><th>Uploaded</th><th>File</th><th className="num">Lines</th><th>Status</th><th>Result</th><th>By</th><th><span className="sr-only">Actions</span></th></tr>}>
          {rows.map((b) => <BatchRow key={b.id} b={b} me={me} onChange={() => setTick(tick + 1)} />)}
        </Table>
      )}
    </>
  );
}

function BatchRow({ b, me, onChange }: { b: Batch; me: Me; onChange: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const a = useAction();
  const canDecide = b.status === 'proposed' && me.role === 'approver' && b.proposedBy !== me.userId;
  return (
    <>
      <tr>
        <td>{when(b.createdAt)}</td>
        <td>{b.fileName}</td>
        <td className="num">{b.items}</td>
        <td><span className={`badge ${b.status === 'applied' ? 'good' : b.status === 'rejected' ? 'bad' : 'warn'}`}>{STATUS[b.status]}</span></td>
        <td className="wrap">
          {b.status === 'applied' ? `${b.applied ?? 0} applied${b.failed ? `, ${b.failed} not applied` : ''}` : b.decisionNote ?? '—'}
          {b.errors && b.errors.length > 0 && (
            <details><summary>Lines not applied</summary><ul className="list">{b.errors.slice(0, 50).map((e, i) => <li key={i}>{e}</li>)}</ul></details>
          )}
        </td>
        <td>{who(b.proposedBy, me.userId)}</td>
        <td className="actions">
          {canDecide && (
            <>
              <button className="primary inline" disabled={a.busy} onClick={() => a.run(async () => { await api(`/insurer/cover-batches/${b.id}/approve`, { method: 'POST', body: {} }); onChange(); })}>Approve and apply</button>
              <button className="secondary small" onClick={() => setRejecting(!rejecting)}>{rejecting ? 'Close' : 'Reject'}</button>
            </>
          )}
          {b.status === 'proposed' && !canDecide && <span className="muted">{b.proposedBy === me.userId ? 'A different approver must decide' : 'Needs the approver role'}</span>}
        </td>
      </tr>
      {(rejecting || a.error) && (
        <tr className="detail">
          <td colSpan={7}>
            {rejecting && (
              <form onSubmit={(e) => a.run(async () => { await api(`/insurer/cover-batches/${b.id}/reject`, { method: 'POST', body: { note } }); onChange(); }, e)}>
                <label htmlFor={`rej-${b.id}`}>Why is it rejected?</label>
                <input id={`rej-${b.id}`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} required />
                <button className="primary inline danger top-gap" disabled={a.busy || note.trim().length < 5}>Reject file</button>
              </form>
            )}
            <ErrorLine error={a.error} />
          </td>
        </tr>
      )}
    </>
  );
}
