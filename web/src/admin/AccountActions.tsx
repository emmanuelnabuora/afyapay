import { FormEvent, useState } from 'react';
import { api } from '../staff/api';
import { ErrorLine, useAction } from '../staff/ui';
import { has, Me } from './types';

type Action = 'suspend' | 'reset_authenticator' | 'reactivate';
const LABEL: Record<Action, string> = { suspend: 'Suspend', reset_authenticator: 'Reset authenticator…', reactivate: 'Reactivate…' };
const DONE: Record<Action, string> = {
  suspend: 'Suspended; their access has ended.',
  reset_authenticator: 'Reset requested; waiting for approval.',
  reactivate: 'Reactivation requested; waiting for approval.',
};

/**
 * Account actions for a staff or insurer user. Suspending takes access away at
 * once. Resetting an authenticator or reactivating gives access back, so it is
 * a request a super administrator approves.
 */
export function AccountActions({ me, type, account, onDone }: { me: Me; type: 'staff_user' | 'insurer_user'; account: { id: string; email: string; status: string; mfaEnrolled: boolean }; onDone: () => void }) {
  const [open, setOpen] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const a = useAction();
  if (type === 'staff_user' && account.id === me.id) return <span className="muted">—</span>;

  const offered: Action[] = [];
  if (account.status === 'active' && has(me, 'compliance', 'super_admin')) offered.push('suspend');
  if (account.mfaEnrolled) offered.push('reset_authenticator');
  if (account.status === 'suspended') offered.push('reactivate');
  if (done) return <span className="ok" role="status">{done}</span>;
  if (!offered.length) return <span className="muted">—</span>;

  const send = (e: FormEvent) =>
    a.run(async () => {
      if (open === 'suspend') await api(`/admin/accounts/${type}/${account.id}/suspend`, { method: 'POST', body: { reason } });
      else await api(`/admin/accounts/${type}/${account.id}/requests`, { method: 'POST', body: { action: open, reason } });
      setDone(DONE[open!]);
      onDone();
    }, e);

  return open ? (
    <form className="inline-form" onSubmit={send}>
      <label htmlFor={`why-${account.id}`}>{open === 'suspend' ? 'Why suspend? It ends their access now.' : 'Why? Say how you confirmed who is asking. A super administrator approves it.'}</label>
      <input id={`why-${account.id}`} aria-label="Reason" value={reason} minLength={5} maxLength={500} onChange={(e) => setReason(e.target.value)} required autoFocus />
      <ErrorLine error={a.error} />
      <div className="actions">
        <button className={open === 'suspend' ? 'primary inline danger' : 'primary inline'} disabled={a.busy}>{open === 'suspend' ? 'Suspend now' : 'Send request'}</button>
        <button type="button" className="secondary small" onClick={() => { setOpen(null); setReason(''); }}>Cancel</button>
      </div>
    </form>
  ) : (
    <div className="actions">
      {offered.map((o) => (
        <button key={o} type="button" className="secondary small" onClick={() => setOpen(o)}>{LABEL[o]}</button>
      ))}
    </div>
  );
}
