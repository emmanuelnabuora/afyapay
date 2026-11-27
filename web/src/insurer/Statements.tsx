import { useEffect, useState } from 'react';
import { api, download, upload, when } from './api';
import type { Me } from './Portal';
import { ErrorLine, FilePick, Table, useAction, who } from './ui';

interface Summary { id: string; fileName: string; lineCount: number; matched: number; alreadyMatched?: number; exceptions: number; missingFromStatement?: number; periodFrom: string | null; periodTo: string | null; uploadedBy?: string; uploadedAt?: string }
interface Mismatch { id: string; kind: string; detail: string; status: 'open' | 'resolved'; owner: string | null; dueAt: string; overdue: boolean; resolution: { note: string; by: string; at: string } | null; createdAt: string }
interface Doc { id: string; fileName: string; bytes: number; status: 'awaiting_review' | 'transcribed' | 'rejected'; reviewNote: string | null; uploadedBy: string; uploadedAt: string }
interface Mapping { receiptCol: string; policyCol: string; amountCol: string; dateCol: string; dateFormat: 'YYYY-MM-DD' | 'DD/MM/YYYY' }
type Ageing = Record<'under_1_day' | '1_to_3_days' | '3_to_7_days' | 'over_7_days' | 'overdue', number>;

const KIND: Record<string, string> = {
  unparseable_line: 'Line could not be read',
  duplicate_line: 'Line appears twice',
  unknown_receipt: 'Receipt not among AfyaPay payments',
  amount_mismatch: 'Amount differs',
  policy_mismatch: 'Policy number differs',
  date_mismatch: 'Date differs',
  missing_from_statement: 'Payment missing from your statement',
};

/** Statements from the insurer, matched against payments M-Pesa confirmed to its paybill, and the mismatches to work through. */
export function Statements({ me, canAct }: { me: Me; canAct: boolean }) {
  const [statements, setStatements] = useState<Summary[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [ageing, setAgeing] = useState<Ageing | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick(tick + 1);

  useEffect(() => {
    api<Summary[]>('/insurer/statements').then(setStatements).catch(() => undefined);
    api<Doc[]>('/insurer/statement-documents').then(setDocs).catch(() => undefined);
    api<Ageing>('/insurer/reports/exception-ageing').then(setAgeing).catch(() => undefined);
  }, [tick]);

  async function send(f: File) {
    setResult(null);
    if (/\.pdf$/i.test(f.name)) {
      await upload('/insurer/statement-documents', f);
      setResult(`${f.name} is held for a colleague to read and type up. Nothing in a PDF is matched automatically.`);
    } else {
      const s = await upload<Summary>('/insurer/statements', f);
      setResult(`${s.fileName}: ${s.lineCount} lines. ${s.matched} matched${s.alreadyMatched ? `, ${s.alreadyMatched} already matched before` : ''}, ${s.exceptions} need checking${s.missingFromStatement ? `, and ${s.missingFromStatement} payments are missing from the statement` : ''}.`);
    }
    refresh();
  }

  return (
    <>
      <h1>Statements</h1>
      <p className="muted">Upload your paybill statement. Each line is matched to a payment M-Pesa confirmed to your paybill; anything that does not match becomes a mismatch to check.</p>
      {ageing && (
        <dl className="stats">
          <div><dt>Open mismatches</dt><dd>{ageing.under_1_day + ageing['1_to_3_days'] + ageing['3_to_7_days'] + ageing.over_7_days}</dd></div>
          <div><dt>Past their due time</dt><dd>{ageing.overdue}</dd></div>
          <div><dt>Open over 7 days</dt><dd>{ageing.over_7_days}</dd></div>
        </dl>
      )}
      <div className="cols">
        {canAct && (
          <section className="card">
            <h2>Upload a statement</h2>
            <FilePick id="statement" label="CSV, Excel or PDF file" accept=".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hint="Up to 5 MB (10 MB for PDF). The same file cannot be uploaded twice." button="Upload and match" onSend={send} />
            {result && <p className="ok top-gap" role="status">{result}</p>}
          </section>
        )}
        <MappingCard canAct={canAct} />
      </div>
      <Mismatches me={me} canAct={canAct} tick={tick} onChange={refresh} />
      <h2>Uploaded statements</h2>
      {statements.length === 0 ? <p className="card empty muted">None yet.</p> : (
        <Table head={<tr><th>Uploaded</th><th>File</th><th>Period</th><th className="num">Lines</th><th className="num">Matched</th><th className="num">To check</th><th>By</th></tr>}>
          {statements.map((s) => (
            <tr key={s.id}>
              <td>{when(s.uploadedAt ?? null)}</td><td>{s.fileName}</td><td>{s.periodFrom ? `${s.periodFrom} to ${s.periodTo}` : '—'}</td>
              <td className="num">{s.lineCount}</td><td className="num">{s.matched}</td><td className="num">{s.exceptions}</td><td>{who(s.uploadedBy ?? null, me.userId)}</td>
            </tr>
          ))}
        </Table>
      )}
      <PdfDocs me={me} canAct={canAct} docs={docs} onChange={refresh} />
    </>
  );
}

function MappingCard({ canAct }: { canAct: boolean }) {
  const [m, setM] = useState<Mapping | null>(null);
  const [saved, setSaved] = useState(false);
  const a = useAction();
  useEffect(() => {
    api<Mapping>('/insurer/statement-mapping').then(setM).catch(() => undefined);
  }, []);
  if (!m) return null;
  const field = (k: keyof Mapping, label: string) => (
    <>
      <label htmlFor={`map-${k}`}>{label}</label>
      <input id={`map-${k}`} value={m[k]} disabled={!canAct} maxLength={60} onChange={(e) => { setSaved(false); setM({ ...m, [k]: e.target.value }); }} required />
    </>
  );
  return (
    <details className="card">
      <summary>Column names in your statement</summary>
      <form onSubmit={(e) => a.run(async () => { setM(await api<Mapping>('/insurer/statement-mapping', { method: 'POST', body: m })); setSaved(true); }, e)}>
        {field('receiptCol', 'M-Pesa receipt column')}
        {field('policyCol', 'Policy number column')}
        {field('amountCol', 'Amount column')}
        {field('dateCol', 'Payment date column')}
        <label htmlFor="map-format">Date format</label>
        <select id="map-format" value={m.dateFormat} disabled={!canAct} onChange={(e) => { setSaved(false); setM({ ...m, dateFormat: e.target.value as Mapping['dateFormat'] }); }}>
          <option value="YYYY-MM-DD">2026-11-27</option>
          <option value="DD/MM/YYYY">27/11/2026</option>
        </select>
        <ErrorLine error={a.error} />
        {saved && <p className="ok top-gap" role="status">Column names updated.</p>}
        {canAct && <button className="primary inline top-gap" disabled={a.busy}>Use these column names</button>}
      </form>
    </details>
  );
}

function Mismatches({ me, canAct, tick, onChange }: { me: Me; canAct: boolean; tick: number; onChange: () => void }) {
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [rows, setRows] = useState<Mismatch[] | null>(null);
  useEffect(() => {
    api<Mismatch[]>(`/insurer/exceptions?status=${status}`).then(setRows).catch(() => setRows([]));
  }, [status, tick]);
  return (
    <>
      <div className="row-between">
        <h2>Mismatches</h2>
        <div className="seg" role="group" aria-label="Show">
          <button type="button" aria-pressed={status === 'open'} onClick={() => setStatus('open')}>Open</button>
          <button type="button" aria-pressed={status === 'resolved'} onClick={() => setStatus('resolved')}>Resolved</button>
        </div>
      </div>
      {!rows ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="card empty muted">{status === 'open' ? 'Nothing to check.' : 'None resolved yet.'}</p> : (
        <Table head={<tr><th>What</th><th>Details</th><th>{status === 'open' ? 'Due' : 'Resolved'}</th><th>Owner</th><th><span className="sr-only">Actions</span></th></tr>}>
          {rows.map((r) => <MismatchRow key={r.id} row={r} me={me} canAct={canAct && status === 'open'} onChange={onChange} />)}
        </Table>
      )}
    </>
  );
}

function MismatchRow({ row: r, me, canAct, onChange }: { row: Mismatch; me: Me; canAct: boolean; onChange: () => void }) {
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const a = useAction();
  return (
    <>
      <tr>
        <td>{KIND[r.kind] ?? r.kind}</td>
        <td className="wrap">{r.resolution ? <>{r.detail}<br /><span className="muted">Resolved: {r.resolution.note}</span></> : r.detail}</td>
        <td>{r.resolution ? when(r.resolution.at) : <>{when(r.dueAt)}{r.overdue && <span className="badge bad small">Overdue</span>}</>}</td>
        <td>{who(r.resolution?.by ?? r.owner, me.userId)}</td>
        <td className="actions">
          {canAct && r.owner !== me.userId && <button className="secondary small" disabled={a.busy} onClick={() => a.run(async () => { await api(`/insurer/exceptions/${r.id}/assign`, { method: 'POST' }); onChange(); })}>Take it</button>}
          {canAct && <button className="secondary small" aria-expanded={resolving} onClick={() => setResolving(!resolving)}>{resolving ? 'Close' : 'Resolve'}</button>}
        </td>
      </tr>
      {(resolving || a.error) && (
        <tr className="detail">
          <td colSpan={5}>
            {resolving && (
              <form onSubmit={(e) => a.run(async () => { await api(`/insurer/exceptions/${r.id}/resolve`, { method: 'POST', body: { note } }); setResolving(false); onChange(); }, e)}>
                <label htmlFor={`note-${r.id}`}>How was it resolved?</label>
                <input id={`note-${r.id}`} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="For example: customer paid twice, second payment refunded by our finance team" required />
                <button className="primary inline top-gap" disabled={a.busy || note.trim().length < 5}>Mark resolved</button>
              </form>
            )}
            <ErrorLine error={a.error} />
          </td>
        </tr>
      )}
    </>
  );
}

function PdfDocs({ me, canAct, docs, onChange }: { me: Me; canAct: boolean; docs: Doc[]; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  if (docs.length === 0) return null;
  const STATUS = { awaiting_review: 'Waiting to be typed up', transcribed: 'Typed up and matched', rejected: 'Rejected' };
  return (
    <>
      <h2>PDF statements</h2>
      <p className="muted">A PDF is never matched automatically. Someone other than the uploader downloads it, types the lines into a CSV or Excel file with the same columns, and uploads that here.</p>
      <ErrorLine error={error} />
      <Table head={<tr><th>Uploaded</th><th>File</th><th>Status</th><th>By</th><th><span className="sr-only">Actions</span></th></tr>}>
        {docs.map((d) => (
          <tr key={d.id}>
            <td>{when(d.uploadedAt)}</td>
            <td>{d.fileName}</td>
            <td>{STATUS[d.status]}</td>
            <td>{who(d.uploadedBy, me.userId)}</td>
            <td className="actions wrap">
              <button className="secondary small" onClick={() => download(`/insurer/statement-documents/${d.id}/content`, d.fileName).catch((e) => setError(e.message))}>Download</button>
              {canAct && d.status === 'awaiting_review' && d.uploadedBy !== me.userId && (
                <FilePick id={`tx-${d.id}`} label="Typed-up lines" accept=".csv,.xlsx" button="Upload and match" onSend={async (f) => { await upload(`/insurer/statement-documents/${d.id}/transcription`, f); onChange(); }} />
              )}
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}
