import { useEffect, useState } from 'react';
import { api, when } from '../staff/api';
import { Table } from '../staff/ui';
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
      <p className="muted">Before you act on a request, confirm who is asking with the insurer's named administrator, not the caller alone. Suspending ends access at once. Resetting an authenticator or reactivating needs a super administrator's approval.</p>
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
    </>
  );
}
