import { useEffect, useState } from 'react';
import { api, ApiError, kes } from '../api';
import type { Payment } from '../types';

const DONE = ['confirmed', 'failed', 'expired', 'needs_review'];

/** Waits for M-Pesa (checking every 3 seconds), then shows the outcome and receipt. */
export function Receipt({ paymentId, go }: { paymentId: string; go: (to: string) => void }) {
  const [payment, setPayment] = useState<Payment | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const p = await api<Payment>(`/me/payments/${paymentId}`);
        if (stop) return;
        setPayment(p);
        if (!DONE.includes(p.status)) timer = setTimeout(load, 3000);
      } catch (e) {
        if (!stop) setError((e as ApiError).message);
      }
    };
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [paymentId]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!payment) return <p className="muted">Loading…</p>;

  return (
    <section className="card narrow receipt">
      {payment.status === 'confirmed' && payment.receipt ? (
        <>
          <p className="badge good">Payment received by M-Pesa</p>
          <h1>{kes(payment.amountMinor)} paid to {payment.insurer.name}</h1>
          <dl className="receipt-lines">
            <div><dt>M-Pesa receipt</dt><dd className="mono">{payment.receipt.mpesaReceipt}</dd></div>
            <div><dt>Policy</dt><dd>{payment.policyNumber}</dd></div>
            <div><dt>Date</dt><dd>{new Date(payment.receipt.confirmedAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}</dd></div>
          </dl>
          <p className="hint">Your cover is set by {payment.insurer.name}. Your home screen shows what they last confirmed.</p>
        </>
      ) : payment.status === 'failed' || payment.status === 'expired' ? (
        <>
          <p className="badge bad">Payment didn't go through</p>
          <h1>{payment.failure?.message ?? 'M-Pesa did not complete the payment.'}</h1>
          <p className="muted">No money was taken. You can try again.</p>
        </>
      ) : payment.status === 'needs_review' ? (
        <>
          <p className="badge warn">We're checking this payment</p>
          <h1>{kes(payment.amountMinor)} to {payment.insurer.name}</h1>
          <p className="muted">M-Pesa hasn't given us a clear answer yet. We'll update your home screen when it does. Don't pay again for now.</p>
        </>
      ) : (
        <>
          <p className="badge warn">Waiting for M-Pesa</p>
          <h1>Check your phone</h1>
          <p className="muted">Enter your M-Pesa PIN on the prompt to pay {kes(payment.amountMinor)} to {payment.insurer.name}. AfyaPay never sees your PIN.</p>
          <div className="spinner" aria-hidden />
        </>
      )}
      <button className="primary" onClick={() => go('/')}>Back to my policies</button>
    </section>
  );
}
