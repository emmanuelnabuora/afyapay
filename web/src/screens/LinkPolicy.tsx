import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../api';

interface Insurer {
  code: string;
  name: string;
}

export function LinkPolicy({ go }: { go: (to: string) => void }) {
  const [insurers, setInsurers] = useState<Insurer[]>([]);
  const [insurerCode, setInsurerCode] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [consent, setConsent] = useState<{ version: string; text: string } | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Insurer[]>('/insurers').then(setInsurers).catch((e: ApiError) => setError(e.message));
  }, []);
  useEffect(() => {
    setAgreed(false);
    setConsent(null);
    if (insurerCode) api<{ version: string; text: string }>(`/insurers/${insurerCode}/consent`).then(setConsent).catch((e: ApiError) => setError(e.message));
  }, [insurerCode]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/me/policy-links', { method: 'POST', body: { insurerCode, policyNumber, consent: true, consentTextVersion: consent!.version } });
      go('/');
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card narrow">
      <h1>Link a policy</h1>
      <p className="muted">Your insurer confirms the policy is yours before you can pay it here.</p>
      <form onSubmit={submit}>
        <label htmlFor="insurer">Insurer</label>
        <select id="insurer" value={insurerCode} onChange={(e) => setInsurerCode(e.target.value)} required>
          <option value="">Choose your insurer</option>
          {insurers.map((i) => (
            <option key={i.code} value={i.code}>{i.name}</option>
          ))}
        </select>
        <label htmlFor="policy">Policy number</label>
        <input id="policy" value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value.toUpperCase())} placeholder="As shown on your policy document" required />
        {consent && (
          <label className="consent">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>{consent.text}</span>
          </label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy || !agreed || !policyNumber.trim()}>{busy ? 'Sending…' : 'Ask insurer to confirm'}</button>
        <button type="button" className="secondary" onClick={() => go('/')}>Cancel</button>
      </form>
    </section>
  );
}
