import { FormEvent, useEffect, useState } from 'react';
import { api, download, upload, when } from '../staff/api';
import { ErrorLine, Table, useAction } from '../staff/ui';
import { Gate, has, Me } from './types';

interface Detail extends Gate {
  evidence: { id: string; title: string; fileName: string | null; contentType: string | null; bytes: number | null; uploadedBy: string; uploadedAt: string }[];
  history: { status: string; note: string; by: string; at: string }[];
}

/** Launch gates G0 to G8. Evidence is attached here; only compliance closes or reopens a gate. */
export function Gates({ me, code }: { me: Me; code?: string }) {
  const [gates, setGates] = useState<Gate[] | null>(null);
  useEffect(() => {
    api<Gate[]>('/admin/launch-gates').then(setGates).catch(() => setGates([]));
  }, [code]);
  if (code) return <GateDetail me={me} code={code} />;
  return (
    <>
      <h1>Launch gates</h1>
      <p className="muted">Each gate records evidence that a launch condition is met. Closing a gate records that someone with the compliance role checked that evidence; it is not itself a licence or approval from anyone outside AfyaPay. Live money needs G1 to G5 closed; buying plans needs G6.</p>
      {!gates ? <p className="muted">Loading…</p> : (
        <Table head={<tr><th>Gate</th><th>What it covers</th><th>Needed for</th><th>Status</th><th className="num">Evidence</th><th>Last change</th></tr>}>
          {gates.map((g) => (
            <tr key={g.code}>
              <td><a href={`#/gates/${g.code}`}>{g.code}</a></td>
              <td>{g.title}</td>
              <td>{g.neededFor === 'pilot' ? 'Pilot' : 'Later'}</td>
              <td><span className={`badge ${g.status === 'closed' ? 'good' : 'warn'}`}>{g.status === 'closed' ? 'Closed' : 'Open'}</span></td>
              <td className="num">{g.evidenceCount ?? 0}</td>
              <td>{g.lastChange ? `${g.lastChange.by}, ${when(g.lastChange.at)}` : '—'}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function GateDetail({ me, code }: { me: Me; code: string }) {
  const [g, setG] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [note, setNote] = useState('');
  const [tick, setTick] = useState(0);
  const addEv = useAction();
  const change = useAction();
  useEffect(() => {
    api<Detail>(`/admin/launch-gates/${code}`).then(setG).catch((e) => setError(e.message));
  }, [code, tick]);
  if (error) return <ErrorLine error={error} />;
  if (!g) return <p className="muted">Loading…</p>;

  function addEvidence(e: FormEvent) {
    addEv.run(async () => {
      await upload(`/admin/launch-gates/${code}/evidence`, file, { title });
      setTitle(''); setFile(null); setFileKey(fileKey + 1); setTick(tick + 1);
    }, e);
  }

  return (
    <>
      <a href="#/gates" className="back">← All gates</a>
      <div className="row-between">
        <h1>{g.code} {g.title}</h1>
        <span className={`badge ${g.status === 'closed' ? 'good' : 'warn'}`}>{g.status === 'closed' ? 'Closed' : 'Open'}</span>
      </div>
      <p className="muted">Needed for {g.neededFor === 'pilot' ? 'the pilot' : 'later stages'}.</p>
      <h2>Evidence</h2>
      {g.evidence.length === 0 ? <p className="card empty muted">No evidence yet.</p> : (
        <Table head={<tr><th>Added</th><th>Title</th><th>File</th><th>By</th></tr>}>
          {g.evidence.map((e) => (
            <tr key={e.id}>
              <td>{when(e.uploadedAt)}</td>
              <td className="wrap">{e.title}</td>
              <td>{e.fileName ? <button className="link-button" onClick={() => download(`/admin/launch-gates/${code}/evidence/${e.id}/content`, e.fileName!).catch((x) => setError(x.message))}>{e.fileName}</button> : '—'}</td>
              <td>{e.uploadedBy}</td>
            </tr>
          ))}
        </Table>
      )}
      <div className="cols top-gap">
        {has(me, 'compliance', 'super_admin') && (
          <form className="card" onSubmit={addEvidence}>
            <h2>Add evidence</h2>
            <label htmlFor="ev-title">What it is</label>
            <input id="ev-title" value={title} minLength={3} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="For example: counsel's written opinion, dated" required />
            <label htmlFor="ev-file">File (optional): PDF, PNG or JPEG up to 10 MB</label>
            <input key={fileKey} id="ev-file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <ErrorLine error={addEv.error} />
            <button className="primary inline top-gap" disabled={addEv.busy}>Add evidence</button>
          </form>
        )}
        {has(me, 'compliance') && (
          <form className="card" onSubmit={(e) => change.run(async () => { await api(`/admin/launch-gates/${code}/${g.status === 'closed' ? 'reopen' : 'close'}`, { method: 'POST', body: { note } }); setNote(''); setTick(tick + 1); }, e)}>
            <h2>{g.status === 'closed' ? 'Reopen this gate' : 'Close this gate'}</h2>
            <p className="hint">{g.status === 'closed' ? 'Reopening switches off anything that depends on this gate.' : 'Close only when the evidence above shows the condition is met.'}</p>
            <label htmlFor="gate-note">{g.status === 'closed' ? 'Why reopen?' : 'What the evidence shows'}</label>
            <textarea id="gate-note" value={note} minLength={5} maxLength={1000} onChange={(e) => setNote(e.target.value)} required />
            <ErrorLine error={change.error} />
            <button className={`primary inline top-gap${g.status === 'closed' ? ' danger' : ''}`} disabled={change.busy || note.trim().length < 5 || (g.status === 'open' && g.evidence.length === 0)}>{g.status === 'closed' ? 'Reopen gate' : 'Close gate'}</button>
            {g.status === 'open' && g.evidence.length === 0 && <p className="hint">Add evidence first.</p>}
          </form>
        )}
      </div>
      {g.history.length > 0 && (
        <>
          <h2>History</h2>
          <Table head={<tr><th>When</th><th>Change</th><th>By</th><th>Note</th></tr>}>
            {g.history.map((h, i) => <tr key={i}><td>{when(h.at)}</td><td>{h.status === 'closed' ? 'Closed' : 'Reopened'}</td><td>{h.by}</td><td className="wrap">{h.note}</td></tr>)}
          </Table>
        </>
      )}
    </>
  );
}
