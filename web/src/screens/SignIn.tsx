import { FormEvent, useState } from 'react';
import { api, ApiError, setTokens } from '../api';

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [phone, setPhone] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ challengeId: string }>('/auth/otp', { method: 'POST', body: { phone }, auth: false });
      setChallengeId(res.challengeId);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setTokens(await api('/auth/otp/verify', { method: 'POST', body: { challengeId, code }, auth: false }));
      onSignedIn();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card narrow">
      <h1>Sign in</h1>
      {!challengeId ? (
        <form onSubmit={sendCode}>
          <p className="muted">We'll send a 6-digit code to your phone.</p>
          <label htmlFor="phone">Phone number</label>
          <input id="phone" inputMode="tel" autoComplete="tel" placeholder="07XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          <p className="hint">Test version: use a test number from 0700 000 000 to 0700 000 999.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" disabled={busy || phone.trim().length < 9}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <p className="muted">Enter the code sent to {phone}.</p>
          <label htmlFor="code">Code</label>
          <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
          <p className="hint">Test version: no SMS is sent. The code for test numbers is 123456.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" disabled={busy || code.length !== 6}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <button type="button" className="secondary" onClick={() => { setChallengeId(null); setCode(''); }}>
            Use a different number
          </button>
        </form>
      )}
    </section>
  );
}
