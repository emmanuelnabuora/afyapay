import { FormEvent, useState } from 'react';
import { api, ApiError, kes, when } from '../staff/api';
import { ErrorLine, Table, useAction } from '../staff/ui';

interface Customer {
  id: string; phoneMasked: string; nationalIdMasked: string | null; status: string; createdAt: string;
  policies: { id: string; insurer: string; policyNumber: string; status: string; requestedAt: string; decidedAt: string | null }[];
  recentPayments: { id: string; policyNumber: string; amountMinor: string; status: string; receipt: string | null; createdAt: string }[];
  consents: { purpose: string; insurer: string | null; granted: boolean; textVersion: string; recordedAt: string }[];
}
type Field = 'phone' | 'national_id';

const BY = [
  { value: 'phone', label: 'Phone number', placeholder: '0712 345 678' },
  { value: 'nationalId', label: 'National ID number', placeholder: 'Exact number' },
  { value: 'policyNumber', label: 'Policy number', placeholder: 'Exact policy number' },
  { value: 'customerId', label: 'Customer ID', placeholder: 'From an audit entry or support case' },
] as const;

const PAYMENT = { created: 'Started', prompt_sent: 'Waiting for customer', confirmed: 'Paid to insurer', failed: 'Failed', expired: 'Not completed', needs_review: 'Being checked' } as Record<string, string>;
const LINK = { pending_insurer: 'Waiting for insurer', confirmed: 'Confirmed by insurer', rejected: 'Rejected by insurer', unlinked: 'Unlinked' } as Record<string, string>;

/** Exact-match lookup. Phone and national ID stay masked; seeing one in full needs a second person's approval. */
export function Customers() {
  const [by, setBy] = useState<(typeof BY)[number]['value']>('phone');
  const [value, setValue] = useState('');
  const [result, setResult] = useState<Customer[] | null>(null);
  const a = useAction();
  const search = (e: FormEvent) =>
    a.run(async () => {
      setResult((await api<{ customers: Customer[] }>(`/admin/customers?${by}=${encodeURIComponent(value.trim())}`)).customers);
    }, e);
  const opt = BY.find((b) => b.value === by)!;
  return (
    <>
      <h1>Customers</h1>
      <p className="muted">Exact matches only. Phone and national ID numbers are masked. To see one in full, ask for approval: someone with the compliance or super administrator role decides, and only you can then see it, for 30 minutes. Every look is recorded.</p>
      <form className="filter-row" onSubmit={search}>
        <div><label htmlFor="by">Find by</label><select id="by" value={by} onChange={(e) => { setBy(e.target.value as typeof by); setResult(null); }}>{BY.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</select></div>
        <div className="grow"><label htmlFor="q">{opt.label}</label><input id="q" value={value} onChange={(e) => setValue(e.target.value)} placeholder={opt.placeholder} required /></div>
        <button className="primary inline" disabled={a.busy}>Find</button>
      </form>
      <ErrorLine error={a.error} />
      {result && result.length === 0 && <p className="card empty muted">No customer matches exactly.</p>}
      {result?.map((c) => <CustomerCard key={c.id} c={c} />)}
    </>
  );
}

function CustomerCard({ c }: { c: Customer }) {
  return (
    <section className="card">
      <div className="row-between">
        <h2>Customer <span className="mono small-id">{c.id}</span></h2>
        <span className={`badge ${c.status === 'active' ? 'good' : 'warn'}`}>{c.status}</span>
      </div>
      <dl className="receipt-lines">
        <div><dt>Phone</dt><dd><Unmask c={c} field="phone" masked={c.phoneMasked} /></dd></div>
        <div><dt>National ID</dt><dd>{c.nationalIdMasked ? <Unmask c={c} field="national_id" masked={c.nationalIdMasked} /> : 'Not added'}</dd></div>
        <div><dt>Joined</dt><dd>{when(c.createdAt)}</dd></div>
      </dl>
      <h2>Policies</h2>
      {c.policies.length === 0 ? <p className="muted">None.</p> : (
        <Table head={<tr><th>Insurer</th><th>Policy number</th><th>Status</th><th>Asked</th></tr>}>
          {c.policies.map((p) => <tr key={p.id}><td>{p.insurer}</td><td className="mono">{p.policyNumber}</td><td>{LINK[p.status] ?? p.status}</td><td>{when(p.requestedAt)}</td></tr>)}
        </Table>
      )}
      <h2 className="top-gap">Recent payments</h2>
      {c.recentPayments.length === 0 ? <p className="muted">None.</p> : (
        <Table head={<tr><th>Started</th><th>Policy number</th><th className="num">Amount</th><th>Status</th><th>M-Pesa receipt</th></tr>}>
          {c.recentPayments.map((p) => <tr key={p.id}><td>{when(p.createdAt)}</td><td className="mono">{p.policyNumber}</td><td className="num">{kes(p.amountMinor)}</td><td>{PAYMENT[p.status] ?? p.status}</td><td className="mono">{p.receipt ?? '—'}</td></tr>)}
        </Table>
      )}
      <h2 className="top-gap">Consents</h2>
      {c.consents.length === 0 ? <p className="muted">None.</p> : (
        <Table head={<tr><th>For</th><th>Insurer</th><th>Given</th><th>Wording</th><th>When</th></tr>}>
          {c.consents.map((x, i) => <tr key={i}><td>{x.purpose.replace(/_/g, ' ')}</td><td>{x.insurer ?? '—'}</td><td>{x.granted ? 'Yes' : 'Withdrawn'}</td><td className="mono">{x.textVersion}</td><td>{when(x.recordedAt)}</td></tr>)}
        </Table>
      )}
    </section>
  );
}

const reqKey = (customerId: string, field: Field) => `afyapay.unmask.${customerId}.${field}`;
const storedRequest = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };

/** Ask for approval, then show the full value once someone else approves. The request id is kept for this tab only. */
function Unmask({ c, field, masked }: { c: Customer; field: Field; masked: string }) {
  const key = reqKey(c.id, field);
  const [requestId, setRequestId] = useState<string | null>(storedRequest(key));
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [full, setFull] = useState<string | null>(null);
  const a = useAction();
  const path = field === 'phone' ? 'phone' : 'national-id';

  if (full) return <span className="mono">{full} <span className="hint">(visible to you only; recorded)</span></span>;
  return (
    <div className="unmask">
      <span className="mono">{masked}</span>
      {!requestId && !asking && <button className="link-button" onClick={() => setAsking(true)}>Ask to see in full</button>}
      {requestId && (
        <button className="link-button" disabled={a.busy} onClick={() => a.run(async () => {
          const r = await api<{ phone?: string; nationalId?: string }>(`/admin/customers/${c.id}/${path}?requestId=${requestId}`);
          setFull(r.phone ?? r.nationalId ?? '');
        })}>Show if approved</button>
      )}
      {asking && (
        <form onSubmit={(e) => a.run(async () => {
          const r = await api<{ requestId: string }>(`/admin/customers/${c.id}/unmask-requests`, { method: 'POST', body: { field, reason } });
          try { sessionStorage.setItem(key, r.requestId); } catch { /* this tab only */ }
          setRequestId(r.requestId);
          setAsking(false);
        }, e)}>
          <label htmlFor={`why-${c.id}-${field}`}>Why do you need it? (for example the support case)</label>
          <input id={`why-${c.id}-${field}`} value={reason} minLength={10} maxLength={500} onChange={(e) => setReason(e.target.value)} required />
          <button className="primary inline top-gap" disabled={a.busy || reason.trim().length < 10}>Ask for approval</button>
        </form>
      )}
      {requestId && !a.error && <p className="hint">Asked. Someone with the compliance or super administrator role must approve it.</p>}
      <ErrorLine error={a.error} />
    </div>
  );
}
