import { FormEvent, useEffect, useState } from 'react';
import { api, when } from '../staff/api';
import { ErrorLine, Table, useAction } from '../staff/ui';
import { AccountActions } from './AccountActions';
import { InsurerUser, Me } from './types';

const ROLE = { viewer: 'Viewer', operator: 'Operator', approver: 'Approver' };

/** People at insurers who use the insurer portal. Confirm who is asking with the insurer's named administrator first. */
export function InsurerUsers({ me }: { me: Me }) {
  const [rows, setRows] = useState<InsurerUser[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    api<InsurerUser[]>('/admin/insurer-users').then(setRows).catch(() => setRows([]));
  }, [tick]);
  return (
    <>
      <h1>Insurer users</h1>
      <p className="muted">Before you act on a request, confirm who is asking with the insurer's named administrator, not the caller alone. Suspending ends access at once. Adding someone, resetting an authenticator or reactivating needs a super administrator's approval.</p>
      {!rows ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="card empty muted">No insurer users yet.</p> : (
        <Table head={<tr><th>Person</th><th>Insurer</th><th>Role</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr>}>
          {rows.map((u) => (
            <tr key={u.id}>
              <td className="wrap">{u.email}<div className="hint">{u.displayName}, added {when(u.createdAt)}</div></td>
              <td>{u.insurer}</td>
              <td>{ROLE[u.role]}</td>
              <td>{u.status === 'suspended' ? <span className="badge bad small">Suspended</span> : 'Active'}<div className="hint">{u.mfaEnrolled ? 'Authenticator set up' : 'No authenticator yet'}</div></td>
              <td className="actions"><AccountActions me={me} type="insurer_user" account={u} onDone={() => setTick(tick + 1)} /></td>
            </tr>
          ))}
        </Table>
      )}
      <AddInsurerUser onDone={() => setTick(tick + 1)} />
    </>
  );
}

/** A request to add someone; a super administrator approves it on Approvals, and the account is created then. */
function AddInsurerUser({ onDone }: { onDone: () => void }) {
  const [insurers, setInsurers] = useState<{ code: string; name: string }[]>([]);
  const [insurerCode, setInsurerCode] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<keyof typeof ROLE>('viewer');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  const a = useAction();
  useEffect(() => {
    api<{ code: string; name: string }[]>('/admin/insurers').then(setInsurers).catch(() => undefined);
  }, []);
  const submit = (e: FormEvent) =>
    a.run(async () => {
      await api('/admin/insurer-users/requests', { method: 'POST', body: { insurerCode, email, displayName, role, reason } });
      setEmail(''); setDisplayName(''); setReason(''); setDone(true); onDone();
    }, e);
  return (
    <form className="card top-gap plan-form" onSubmit={submit}>
      <h2>Add an insurer user</h2>
      <p className="muted">Only when the insurer's named administrator asks for it. A super administrator approves the request on Approvals. The new user sets up an authenticator app at first sign-in.</p>
      <div className="two">
        <div>
          <label htmlFor="add-insurer">Insurer</label>
          <select id="add-insurer" value={insurerCode} onChange={(e) => { setDone(false); setInsurerCode(e.target.value); }} required>
            <option value="">Choose</option>
            {insurers.map((i) => <option key={i.code} value={i.code}>{i.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="add-role">Role</label>
          <select id="add-role" value={role} onChange={(e) => setRole(e.target.value as keyof typeof ROLE)}>
            <option value="viewer">Viewer: sees policies, payments and statements</option>
            <option value="operator">Operator: also confirms policies and updates cover</option>
            <option value="approver">Approver: also approves large cover files</option>
          </select>
        </div>
      </div>
      <div className="two">
        <div>
          <label htmlFor="add-email">Work email</label>
          <input id="add-email" type="email" value={email} onChange={(e) => { setDone(false); setEmail(e.target.value); }} required />
        </div>
        <div>
          <label htmlFor="add-name">Name</label>
          <input id="add-name" value={displayName} minLength={2} maxLength={120} onChange={(e) => setDisplayName(e.target.value)} required />
        </div>
      </div>
      <p className="hint">Test version: only synthetic addresses ending in @sandbox.test can be added.</p>
      <label htmlFor="add-reason">Who asked, and how you confirmed it</label>
      <input id="add-reason" value={reason} minLength={5} maxLength={500} onChange={(e) => setReason(e.target.value)} required />
      <ErrorLine error={a.error} />
      {done && <p className="ok top-gap" role="status">Requested. A super administrator approves it on Approvals.</p>}
      <button className="primary inline top-gap" disabled={a.busy}>Send request</button>
    </form>
  );
}
