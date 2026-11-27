import { FormEvent, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError, setToken } from './api';

type Step = { kind: 'email' } | { kind: 'code'; challengeId: string } | { kind: 'enrol'; ticket: string; secret: string; url: string } | { kind: 'mfa'; ticket: string };

/** The setup QR code, drawn in the browser so the key never goes to another service. */
function SetupQr({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(url, { margin: 1, width: 200, errorCorrectionLevel: 'M' }).then((d) => live && setSrc(d), () => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [url]);
  return src ? <img className="qr" src={src} width={200} height={200} alt="QR code to scan with your authenticator app" /> : null;
}

/** Email code, then an authenticator app code. First sign-in sets the authenticator up. */
export function SignIn({ onSignedIn, authBase, title }: { onSignedIn: () => void; authBase: '/insurer-auth' | '/admin-auth'; title: string }) {
  const [step, setStep] = useState<Step>({ kind: 'email' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (step.kind === 'email') {
        const r = await api<{ challengeId: string }>(`${authBase}/email-code`, { method: 'POST', body: { email } });
        setStep({ kind: 'code', challengeId: r.challengeId });
      } else if (step.kind === 'code') {
        const r = await api<{ mfaTicket: string; enrolled: boolean }>(`${authBase}/email-code/verify`, { method: 'POST', body: { challengeId: step.challengeId, code } });
        if (r.enrolled) setStep({ kind: 'mfa', ticket: r.mfaTicket });
        else {
          const e2 = await api<{ secret: string; otpauthUrl: string }>(`${authBase}/mfa/enrol`, { method: 'POST', body: { mfaTicket: r.mfaTicket } });
          setStep({ kind: 'enrol', ticket: r.mfaTicket, secret: e2.secret, url: e2.otpauthUrl });
        }
      } else {
        const r = await api<{ accessToken: string; expiresIn: number }>(`${authBase}/mfa/verify`, { method: 'POST', body: { mfaTicket: step.ticket, code } });
        setToken(r.accessToken, r.expiresIn);
        onSignedIn();
      }
      setCode('');
    });
  };

  return (
    <section className="card narrow signin">
      <h1>{title}</h1>
      <form onSubmit={submit}>
        {step.kind === 'email' && (
          <>
            <label htmlFor="email">Work email</label>
            <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <p className="hint">Test version: only synthetic addresses ending @sandbox.test can sign in.</p>
          </>
        )}
        {step.kind === 'code' && (
          <>
            <label htmlFor="code">Code sent to {email}</label>
            <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
            <p className="hint">Test version: no email is sent. The code is 246810.</p>
          </>
        )}
        {step.kind === 'enrol' && (
          <>
            <h2>Set up your authenticator app</h2>
            <p className="muted">Signing in always needs a code from an authenticator app, such as Google Authenticator or Microsoft Authenticator. In your app, add an account and scan this code:</p>
            <SetupQr url={step.url} />
            <p className="muted">Can't scan it? Choose to enter a setup key instead, and type this key:</p>
            <p className="secret mono" aria-label="Setup key">{step.secret.match(/.{1,4}/g)!.join(' ')}</p>
            <p className="hint">On a phone with the app installed you can <a href={step.url}>open the setup link</a> instead. Keep this code and key private.</p>
          </>
        )}
        {(step.kind === 'enrol' || step.kind === 'mfa') && (
          <>
            <label htmlFor="totp">Code from your authenticator app</label>
            <input id="totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Checking…' : step.kind === 'email' ? 'Send code' : 'Continue'}</button>
        {step.kind !== 'email' && (
          <button type="button" className="secondary" onClick={() => { setStep({ kind: 'email' }); setCode(''); setError(null); }}>Start again</button>
        )}
      </form>
    </section>
  );
}
