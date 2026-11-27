import { useEffect, useState } from 'react';
import { api, when } from '../staff/api';
import { ErrorLine, Table, useAction } from '../staff/ui';

interface Event { seq: number; occurredAt: string; actorType: string; actorId: string | null; action: string; subjectType: string | null; subjectId: string | null; hash: string }
interface Check { intact: boolean; checked: number; total: number; firstBadSeq: number | null; problem: string | null }

/** The append-only audit log, newest first, with a check that its hash chain is unbroken. */
export function Audit() {
  const [events, setEvents] = useState<Event[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [action, setAction] = useState('');
  const [check, setCheck] = useState<Check | null>(null);
  const a = useAction();
  const verify = useAction();

  const load = (before: number | null, reset: boolean) =>
    a.run(async () => {
      const q = new URLSearchParams({ limit: '100' });
      if (before) q.set('beforeSeq', String(before));
      if (action.trim()) q.set('action', action.trim());
      const r = await api<{ events: Event[]; nextBeforeSeq: number | null }>(`/admin/audit-events?${q}`);
      setEvents(reset ? r.events : [...events, ...r.events]);
      setNext(r.nextBeforeSeq);
    });
  useEffect(() => {
    load(null, true);
  }, []);

  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">Every sign-in, approval, look at a customer's full details and change is recorded here and cannot be edited or deleted. Each entry carries a hash of the one before, so any change breaks the chain.</p>
      <div className="cols">
        <form className="filter-row" onSubmit={(e) => { e.preventDefault(); load(null, true); }}>
          <div className="grow"><label htmlFor="act">Action starts with</label><input id="act" value={action} onChange={(e) => setAction(e.target.value)} placeholder="For example: customer. or approval." /></div>
          <button className="primary inline" disabled={a.busy}>Filter</button>
        </form>
        <div className="card">
          <button className="secondary inline" disabled={verify.busy} onClick={() => verify.run(async () => setCheck(await api<Check>('/admin/audit-events/verify', { method: 'POST' })))}>{verify.busy ? 'Checking…' : 'Check the chain'}</button>
          {check && (
            <p className={check.intact ? 'ok top-gap' : 'error top-gap'} role="status">
              {check.intact ? `Intact: all ${check.total} entries checked.` : `Broken at entry ${check.firstBadSeq}: ${check.problem}`}
            </p>
          )}
          <ErrorLine error={verify.error} />
        </div>
      </div>
      <ErrorLine error={a.error} />
      <Table head={<tr><th className="num">#</th><th>When</th><th>Action</th><th>Who</th><th>About</th></tr>}>
        {events.map((e) => (
          <tr key={e.seq}>
            <td className="num">{e.seq}</td>
            <td>{when(e.occurredAt)}</td>
            <td className="mono">{e.action}</td>
            <td>{e.actorType.replace(/_/g, ' ')} <span className="mono small-id">{e.actorId?.slice(0, 8) ?? ''}</span></td>
            <td>{e.subjectType?.replace(/_/g, ' ') ?? '—'} <span className="mono small-id">{e.subjectId?.slice(0, 8) ?? ''}</span></td>
          </tr>
        ))}
      </Table>
      {next && <button className="secondary inline top-gap" disabled={a.busy} onClick={() => load(next, false)}>Show older</button>}
    </>
  );
}
