import { useEffect, useState } from 'react';
import { api, when } from '../staff/api';
import { ErrorLine, Table, useAction } from '../staff/ui';
import { AccountActions } from './AccountActions';
import { has, Me, ROLE_LABEL, Staff } from './types';

/** AfyaPay staff accounts. Roles change only through an approved request. */
export function StaffList({ me }: { me: Me }) {
  const [rows, setRows] = useState<Staff[] | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const a = useAction();
  useEffect(() => {
    api<Staff[]>('/admin/staff').then(setRows).catch(() => setRows([]));
  }, [tick]);
  return (
    <>
      <h1>Staff</h1>
      <p className="muted">Everyone signs in with an email code and an authenticator app. A new account has no role until a role request is approved on the Approvals page. Suspending ends access at once; resetting an authenticator or reactivating needs a super administrator's approval.</p>
      {!rows ? <p className="muted">Loading…</p> : (
        <Table head={<tr><th>Person</th><th>Roles</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr>}>
          {rows.map((s) => (
            <tr key={s.id}>
              <td className="wrap">{s.email}{s.id === me.id && <span className="badge small neutral">You</span>}<div className="hint">{s.displayName}, added {when(s.createdAt)}</div></td>
              <td>{s.roles.map((r) => ROLE_LABEL[r]).join(', ') || 'None'}</td>
              <td>{s.status === 'suspended' ? <span className="badge bad small">Suspended</span> : 'Active'}<div className="hint">{s.mfaEnrolled ? 'Authenticator set up' : 'No authenticator yet'}</div></td>
              <td className="actions"><AccountActions me={me} type="staff_user" account={s} onDone={() => setTick(tick + 1)} /></td>
            </tr>
          ))}
        </Table>
      )}
      {has(me, 'super_admin') && (
        <form className="card top-gap plan-form" onSubmit={(e) => a.run(async () => { await api('/admin/staff', { method: 'POST', body: { email, displayName: name } }); setDone(`${email} added. Propose a role for them on the Approvals page.`); setEmail(''); setName(''); setTick(tick + 1); }, e)}>
          <h2>Add a staff account</h2>
          <div className="two">
            <div><label htmlFor="s-email">Work email</label><input id="s-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
            <div><label htmlFor="s-name">Name</label><input id="s-name" value={name} minLength={2} maxLength={120} onChange={(e) => setName(e.target.value)} required /></div>
          </div>
          <p className="hint">Test version: only addresses ending @sandbox.test can sign in.</p>
          <ErrorLine error={a.error} />
          {done && <p className="ok top-gap" role="status">{done}</p>}
          <button className="primary inline top-gap" disabled={a.busy}>Add account</button>
        </form>
      )}
    </>
  );
}
