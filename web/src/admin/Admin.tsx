import { useEffect, useState } from 'react';
import { api, clearToken, hasToken, whenExpired } from '../staff/api';
import { SignIn } from '../staff/SignIn';
import { Approvals } from './Approvals';
import { Audit } from './Audit';
import { Customers } from './Customers';
import { Gates } from './Gates';
import { Overview } from './Overview';
import { StaffList } from './StaffList';
import { has, Me, Role, ROLE_LABEL } from './types';

const TABS: { path: string; label: string; roles: Role[] }[] = [
  { path: 'overview', label: 'Overview', roles: ['support', 'finance', 'compliance', 'super_admin'] },
  { path: 'customers', label: 'Customers', roles: ['support', 'finance', 'compliance', 'super_admin'] },
  { path: 'approvals', label: 'Approvals', roles: ['compliance', 'super_admin'] },
  { path: 'gates', label: 'Launch gates', roles: ['support', 'finance', 'compliance', 'super_admin'] },
  { path: 'staff', label: 'Staff', roles: ['compliance', 'super_admin'] },
  { path: 'audit', label: 'Audit log', roles: ['compliance', 'super_admin'] },
];

function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function Admin() {
  const [signedIn, setSignedIn] = useState(hasToken());
  const [expired, setExpired] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const route = useRoute();

  useEffect(() => {
    whenExpired(() => {
      setSignedIn(false);
      setMe(null);
      setExpired(true);
    });
  }, []);
  useEffect(() => {
    if (signedIn) api<Me>('/admin/me').then(setMe).catch(() => undefined);
  }, [signedIn]);

  const tabs = me ? TABS.filter((t) => has(me, ...t.roles)) : [];
  const tab = tabs.find((t) => t.path === route[0])?.path ?? 'overview';

  return (
    <div className="portal">
      <div className="sandbox" role="note">Test version with synthetic staff and customers. No real money moves and no real cover is affected.</div>
      <header className="portal-bar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>AfyaPay</span>
          <span className="portal-tag">Staff admin</span>
        </div>
        {signedIn && me && (
          <div className="who">
            <strong>{me.email}</strong>
            <span className="muted">{me.roles.map((r) => ROLE_LABEL[r]).join(', ') || 'No role yet'}</span>
            <button type="button" className="link-button" onClick={() => { clearToken(); setSignedIn(false); setMe(null); }}>Sign out</button>
          </div>
        )}
      </header>
      {signedIn && me && (
        <nav className="tabs" aria-label="Admin sections">
          {tabs.map((t) => (
            <a key={t.path} href={`#/${t.path}`} aria-current={tab === t.path ? 'page' : undefined}>{t.label}</a>
          ))}
        </nav>
      )}
      <main className="portal-main">
        {!signedIn ? (
          <>
            {expired && <p className="notice narrow-notice" role="status">Your session ended. Sign in again to continue.</p>}
            <SignIn authBase="/admin-auth" title="AfyaPay staff" onSignedIn={() => { setExpired(false); setSignedIn(true); }} />
          </>
        ) : !me ? (
          <p className="muted">Loading…</p>
        ) : me.roles.length === 0 ? (
          <p className="card empty muted">Your account has no role yet. A super administrator proposes one and a second super administrator approves it.</p>
        ) : tab === 'customers' ? (
          <Customers />
        ) : tab === 'approvals' ? (
          <Approvals me={me} />
        ) : tab === 'gates' ? (
          <Gates me={me} code={route[1]} />
        ) : tab === 'staff' ? (
          <StaffList me={me} />
        ) : tab === 'audit' ? (
          <Audit />
        ) : (
          <Overview />
        )}
      </main>
      <footer className="foot">AfyaPay never holds customer money: payments go from M-Pesa straight to each insurer's paybill. Only insurers change cover.</footer>
    </div>
  );
}
