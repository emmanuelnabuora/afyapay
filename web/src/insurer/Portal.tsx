import { useEffect, useState } from 'react';
import { api, clearToken, hasToken, whenExpired } from '../staff/api';
import { CoverFiles } from './CoverFiles';
import { Interests } from './Interests';
import { Payments } from './Payments';
import { Plans } from './Plans';
import { Requests } from './Requests';
import { SignIn } from '../staff/SignIn';
import { Statements } from './Statements';

export interface Me {
  userId: string;
  role: 'viewer' | 'operator' | 'approver';
  insurer: { code: string; name: string } | null;
}

const TABS = [
  { path: 'requests', label: 'Policy requests' },
  { path: 'payments', label: 'Payments' },
  { path: 'statements', label: 'Statements' },
  { path: 'cover-files', label: 'Cover files' },
  { path: 'plans', label: 'Your plans' },
  { path: 'interest', label: 'Interested customers' },
] as const;

const ROLE_LABEL = { viewer: 'Viewer (read only)', operator: 'Operator', approver: 'Approver' };

function useTab(): string {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/')[0] || 'requests';
  const [tab, setTab] = useState(read);
  useEffect(() => {
    const on = () => setTab(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return tab;
}

export function Portal() {
  const [signedIn, setSignedIn] = useState(hasToken());
  const [expired, setExpired] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const tab = useTab();

  useEffect(() => {
    whenExpired(() => {
      setSignedIn(false);
      setMe(null);
      setExpired(true);
    });
  }, []);
  useEffect(() => {
    if (signedIn) api<Me>('/insurer/me').then(setMe).catch(() => undefined);
  }, [signedIn]);

  const canAct = me?.role === 'operator' || me?.role === 'approver';

  return (
    <div className="portal">
      <div className="sandbox" role="note">Test version with fictional insurers and synthetic customers. No real money moves and no real cover is affected.</div>
      <header className="portal-bar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>AfyaPay</span>
          <span className="portal-tag">Insurer portal</span>
        </div>
        {signedIn && me && (
          <div className="who">
            <strong>{me.insurer?.name ?? 'Your insurer'}</strong>
            <span className="muted">{ROLE_LABEL[me.role]}</span>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                clearToken();
                setSignedIn(false);
                setMe(null);
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      {signedIn && (
        <nav className="tabs" aria-label="Portal sections">
          {TABS.map((t) => (
            <a key={t.path} href={`#/${t.path}`} aria-current={tab === t.path ? 'page' : undefined}>{t.label}</a>
          ))}
        </nav>
      )}
      <main className="portal-main">
        {!signedIn ? (
          <>
            {expired && <p className="notice narrow-notice" role="status">Your session ended. Sign in again to continue.</p>}
            <SignIn authBase="/insurer-auth" title="Insurer portal" onSignedIn={() => { setExpired(false); setSignedIn(true); }} />
          </>
        ) : !me ? (
          <p className="muted">Loading…</p>
        ) : tab === 'payments' ? (
          <Payments />
        ) : tab === 'statements' ? (
          <Statements me={me} canAct={canAct} />
        ) : tab === 'cover-files' ? (
          <CoverFiles me={me} canAct={canAct} />
        ) : tab === 'plans' ? (
          <Plans canAct={canAct} />
        ) : tab === 'interest' ? (
          <Interests canAct={canAct} />
        ) : (
          <Requests canAct={canAct} />
        )}
      </main>
      <footer className="foot">Customers pay straight from M-Pesa to your paybill. AfyaPay never holds customer money. Only your team can change a policy's cover.</footer>
    </div>
  );
}
