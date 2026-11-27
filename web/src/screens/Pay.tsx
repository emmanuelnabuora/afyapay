import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, kes, toMinor } from '../api';
import type { Payment, Policy } from '../types';

export function Pay({ policyLinkId, go }: { policyLinkId: string; go: (to: string) => void }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ policy: Policy }>(`/me/policies/${policyLinkId}`)
      .then((r) => {
        setPolicy(r.policy);
        const p = r.policy.premium;
        // Suggest what is left of this period's premium, or what is behind.
        const left = p.behindByMinor && p.behindByMinor !== '0' ? Number(p.behindByMinor) : p.premiumMinor ? Number(p.premiumMinor) - Number(p.paidThisPeriodMinor ?? 0) : 0;
        if (left > 0) setAmount(String(Math.ceil(left / 100)));
      })
      .catch((e: ApiError) => setError(e.message));
  }, [policyLinkId]);

  const shillings = Number(amount);
  const valid = Number.isInteger(shillings) && shillings >= 1 && shillings <= 250_000;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payment = await api<Payment>('/me/payments', { method: 'POST', body: { policyLinkId, amountMinor: toMinor(shillings) } });
      go(`/payments/${payment.id}`);
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  if (!policy) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>;
  return (
    <section className="card narrow">
      <h1>Pay {policy.insurer.name}</h1>
      <p className="muted">Policy {policy.policyNumber}. {policy.premium.label}</p>
      <form onSubmit={submit}>
        <label htmlFor="amount">Amount (KES)</label>
        <input id="amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} required />
        {valid && <p className="hint">You'll get an M-Pesa prompt on your phone for {kes(toMinor(shillings))}. The money goes straight to {policy.insurer.name}.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy || !valid}>{busy ? 'Sending prompt…' : 'Send M-Pesa prompt'}</button>
        <button type="button" className="secondary" onClick={() => go('/')}>Cancel</button>
      </form>
    </section>
  );
}
