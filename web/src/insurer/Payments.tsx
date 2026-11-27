import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, kes, when } from '../staff/api';

interface Payment {
  id: string;
  policyNumber: string;
  amountMinor: string;
  status: 'created' | 'prompt_sent' | 'confirmed' | 'failed' | 'expired' | 'needs_review';
  failureCode: string | null;
  mpesaReceipt: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

const STATUS: Record<Payment['status'], { label: string; tone: string }> = {
  created: { label: 'Started', tone: 'neutral' },
  prompt_sent: { label: 'Waiting for customer', tone: 'warn' },
  confirmed: { label: 'Paid to your paybill', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  expired: { label: 'Not completed', tone: 'bad' },
  needs_review: { label: 'Being checked', tone: 'warn' },
};

const nairobiDate = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

/** M-Pesa payments customers made to this insurer's paybill. Dates are Nairobi time. */
export function Payments() {
  const [from, setFrom] = useState(nairobiDate(-30));
  const [to, setTo] = useState(nairobiDate());
  const [rows, setRows] = useState<Payment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api<Payment[]>(`/insurer/payments?from=${from}&to=${to}`).then(setRows).catch((e: ApiError) => setError(e.message));
  };
  useEffect(load, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setRows(null);
    load();
  };

  const confirmed = rows?.filter((r) => r.status === 'confirmed') ?? [];
  const total = confirmed.reduce((sum, r) => sum + BigInt(r.amountMinor), 0n);

  return (
    <>
      <h1>Payments</h1>
      <p className="muted">M-Pesa payments customers made to your paybill through AfyaPay. Dates are Nairobi time.</p>
      <form className="filter-row" onSubmit={submit}>
        <div><label htmlFor="from">From</label><input id="from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required /></div>
        <div><label htmlFor="to">To</label><input id="to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required /></div>
        <button className="primary inline">Show</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {!rows ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <dl className="stats">
            <div><dt>Paid to your paybill</dt><dd>{kes(total.toString())}</dd></div>
            <div><dt>Paid payments</dt><dd>{confirmed.length}</dd></div>
            <div><dt>Not completed or failed</dt><dd>{rows.filter((r) => ['failed', 'expired'].includes(r.status)).length}</dd></div>
          </dl>
          {rows.length === 0 ? (
            <p className="card empty muted">No payments in these dates.</p>
          ) : (
            <div className="table-wrap" role="region" aria-label="Results" tabIndex={0}>
        <table className="grid">
              <thead>
                <tr><th>Started</th><th>Policy number</th><th className="num">Amount</th><th>Status</th><th>M-Pesa receipt</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{when(r.createdAt)}</td>
                    <td className="mono">{r.policyNumber}</td>
                    <td className="num">{kes(r.amountMinor)}</td>
                    <td><span className={`badge ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span></td>
                    <td className="mono">{r.mpesaReceipt ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
