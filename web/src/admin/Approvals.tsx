import { FormEvent, useEffect, useState } from 'react';
import { api, when } from '../staff/api';
import { ErrorLine, Table, useAction } from '../staff/ui';
import { has, InsurerUser, Me, Request, Role, ROLE_LABEL, Staff } from './types';

interface Settings { staffIpAllowlist: string[]; liveMoney: { switchedOn: boolean; allowed: boolean; gatesStillOpen: string[] }; planBuying: { switchedOn: boolean; allowed: boolean } }

const STATUS = { proposed: 'Waiting', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn' };
const SETTING: Record<string, string> = { live_money_enabled: 'Live money', plan_buying_enabled: 'Buying plans through AfyaPay', staff_ip_allowlist: 'Staff IP allow-list' };

function describe(r: Request, staff: Staff[], insurerUsers: InsurerUser[]): string {
  const name = (id: unknown) => staff.find((s) => s.id === id)?.email ?? 'a staff member';
  const p = r.payload;
  switch (r.kind) {
    case 'role_grant': return `Give ${name(p.staffUserId)} the ${ROLE_LABEL[p.role as Role]} role`;
    case 'role_revoke': return `Remove the ${ROLE_LABEL[p.role as Role]} role from ${name(p.staffUserId)}`;
    case 'setting_change':
      return p.key === 'staff_ip_allowlist'
        ? `Set the staff IP allow-list to ${(p.value as string[]).length ? (p.value as string[]).join(', ') : 'empty (any address)'}`
        : `Switch ${SETTING[p.key as string] ?? p.key} ${p.value ? 'on' : 'off'}`;
    case 'account_action': {
      const who = p.accountType === 'staff_user' ? `staff member ${name(p.accountId)}` : (() => { const u = insurerUsers.find((x) => x.id === p.accountId); return u ? `${u.insurer} user ${u.email}` : 'an insurer user'; })();
      return p.action === 'reactivate' ? `Reactivate ${who}` : `Reset the authenticator for ${who} (they set it up again at next sign-in)`;
    }
    case 'customer_unmask': return `Show customer ${String(p.customerId).slice(0, 8)}… ${p.field === 'national_id' ? 'national ID' : 'phone number'} in full, to the person who asked, for 30 minutes`;
  }
}

/** Maker-checker: one person proposes, a different person decides. The database refuses anything else. */
export function Approvals({ me }: { me: Me }) {
  const [status, setStatus] = useState<string>('proposed');
  const [rows, setRows] = useState<Request[] | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [insurerUsers, setInsurerUsers] = useState<InsurerUser[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick(tick + 1);
  useEffect(() => {
    api<Request[]>(`/admin/approvals${status === 'all' ? '' : `?status=${status}`}`).then(setRows).catch(() => setRows([]));
    api<Staff[]>('/admin/staff').then(setStaff).catch(() => undefined);
    api<InsurerUser[]>('/admin/insurer-users').then(setInsurerUsers).catch(() => undefined);
  }, [status, tick]);

  return (
    <>
      <div className="row-between">
        <h1>Approvals</h1>
        <div className="seg" role="group" aria-label="Show">
          {['proposed', 'approved', 'rejected', 'all'].map((s) => (
            <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{s === 'all' ? 'All' : STATUS[s as keyof typeof STATUS]}</button>
          ))}
        </div>
      </div>
      <p className="muted">Role changes, setting changes, account resets and reactivations, and requests to see a customer's full details. The person who proposes never decides, and nobody decides a change to their own roles.</p>
      {!rows ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="card empty muted">Nothing here.</p> : (
        <Table head={<tr><th>Asked</th><th>Change</th><th>Reason</th><th>By</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr>}>
          {rows.map((r) => <Row key={r.id} r={r} me={me} staff={staff} insurerUsers={insurerUsers} onChange={refresh} />)}
        </Table>
      )}
      {has(me, 'super_admin') && <Propose staff={staff} onDone={() => { setStatus('proposed'); refresh(); }} />}
    </>
  );
}

function Row({ r, me, staff, insurerUsers, onChange }: { r: Request; me: Me; staff: Staff[]; insurerUsers: InsurerUser[]; onChange: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const a = useAction();
  const mine = r.proposedBy.id === me.id;
  const aboutMe = ((r.kind === 'role_grant' || r.kind === 'role_revoke') && r.payload.staffUserId === me.id) || (r.kind === 'account_action' && r.payload.accountId === me.id);
  const canDecide = r.status === 'proposed' && !mine && !aboutMe && (has(me, 'super_admin') || (r.kind === 'customer_unmask' && has(me, 'compliance')));
  const act = (path: string, body: unknown) => a.run(async () => { await api(`/admin/approvals/${r.id}/${path}`, { method: 'POST', body }); onChange(); });
  return (
    <>
      <tr>
        <td>{when(r.createdAt)}</td>
        <td className="wrap">{describe(r, staff, insurerUsers)}</td>
        <td className="wrap">{r.reason}</td>
        <td>{mine ? 'You' : r.proposedBy.email}</td>
        <td className="wrap">
          <span className={`badge ${r.status === 'approved' ? 'good' : r.status === 'proposed' ? 'warn' : 'neutral'}`}>{STATUS[r.status]}</span>
          {r.decidedBy && <div className="hint">{r.decidedBy.email}, {when(r.decidedAt)}{r.decisionNote ? `: ${r.decisionNote}` : ''}</div>}
        </td>
        <td className="actions">
          {canDecide && <>
            <button className="primary inline" disabled={a.busy} onClick={() => act('approve', {})}>Approve</button>
            <button className="secondary small" onClick={() => setRejecting(!rejecting)}>{rejecting ? 'Close' : 'Reject'}</button>
          </>}
          {r.status === 'proposed' && mine && <button className="secondary small" disabled={a.busy} onClick={() => act('withdraw', undefined)}>Withdraw</button>}
          {r.status === 'proposed' && !canDecide && !mine && <span className="muted">{aboutMe ? 'About you: someone else decides' : 'Needs a super administrator'}</span>}
        </td>
      </tr>
      {(rejecting || a.error) && (
        <tr className="detail"><td colSpan={6}>
          {rejecting && (
            <form onSubmit={(e) => { e.preventDefault(); act('reject', { note }); }}>
              <label htmlFor={`rej-${r.id}`}>Why is it rejected?</label>
              <input id={`rej-${r.id}`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} required />
              <button className="primary inline danger top-gap" disabled={a.busy || note.trim().length < 5}>Reject request</button>
            </form>
          )}
          <ErrorLine error={a.error} />
        </td></tr>
      )}
    </>
  );
}

function Propose({ staff, onDone }: { staff: Staff[]; onDone: () => void }) {
  const [kind, setKind] = useState<'role_grant' | 'role_revoke' | 'setting_change'>('role_grant');
  const [staffUserId, setStaffUserId] = useState('');
  const [role, setRole] = useState<Role>('support');
  const [key, setKey] = useState('live_money_enabled');
  const [on, setOn] = useState(true);
  const [ips, setIps] = useState('');
  const [reason, setReason] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [done, setDone] = useState(false);
  const a = useAction();
  useEffect(() => {
    api<Settings>('/admin/settings').then((s) => { setSettings(s); setIps(s.staffIpAllowlist.join('\n')); }).catch(() => undefined);
  }, []);

  function submit(e: FormEvent) {
    const payload = kind === 'setting_change'
      ? { key, value: key === 'staff_ip_allowlist' ? ips.split(/[\s,]+/).filter(Boolean) : on }
      : { staffUserId, role };
    a.run(async () => { await api('/admin/approvals', { method: 'POST', body: { kind, payload, reason } }); setReason(''); setDone(true); onDone(); }, e);
  }

  return (
    <form className="card top-gap plan-form" onSubmit={submit}>
      <h2>Propose a change</h2>
      <p className="muted">A different super administrator must approve it before it takes effect.</p>
      {settings && (
        <p className="hint">
          Now: live money {settings.liveMoney.switchedOn ? 'on' : 'off'}{settings.liveMoney.gatesStillOpen.length ? ` (cannot go on until ${settings.liveMoney.gatesStillOpen.join(', ')} are closed)` : ''};
          buying plans {settings.planBuying.switchedOn ? 'on' : 'off'}{settings.planBuying.allowed ? '' : ' (cannot go on until G6 is closed)'};
          staff IP allow-list {settings.staffIpAllowlist.length ? settings.staffIpAllowlist.join(', ') : 'empty, so any address'}.
        </p>
      )}
      <label htmlFor="kind">Change</label>
      <select id="kind" value={kind} onChange={(e) => { setDone(false); setKind(e.target.value as typeof kind); }}>
        <option value="role_grant">Give someone a role</option>
        <option value="role_revoke">Remove a role from someone</option>
        <option value="setting_change">Change a setting</option>
      </select>
      {kind !== 'setting_change' ? (
        <div className="two">
          <div>
            <label htmlFor="who">Person</label>
            <select id="who" value={staffUserId} onChange={(e) => setStaffUserId(e.target.value)} required>
              <option value="">Choose</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.email}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="role">Role</label>
            <select id="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </div>
        </div>
      ) : (
        <>
          <label htmlFor="key">Setting</label>
          <select id="key" value={key} onChange={(e) => setKey(e.target.value)}>
            {Object.entries(SETTING).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {key === 'staff_ip_allowlist' ? (
            <>
              <label htmlFor="ips">Addresses or ranges, one per line (empty allows any)</label>
              <textarea id="ips" className="mono" value={ips} onChange={(e) => setIps(e.target.value)} placeholder="196.201.214.0/24" />
            </>
          ) : (
            <label className="check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Switch on</label>
          )}
        </>
      )}
      <label htmlFor="reason">Reason</label>
      <input id="reason" value={reason} minLength={5} maxLength={500} onChange={(e) => { setDone(false); setReason(e.target.value); }} required />
      <ErrorLine error={a.error} />
      {done && <p className="ok top-gap" role="status">Proposed. It is listed above, waiting for another super administrator.</p>}
      <button className="primary inline top-gap" disabled={a.busy}>Propose</button>
    </form>
  );
}
