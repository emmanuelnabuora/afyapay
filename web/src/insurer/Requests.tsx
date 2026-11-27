import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, when } from './api';

interface Link {
  id: string;
  policyNumber: string;
  status: 'pending_insurer' | 'confirmed' | 'rejected' | 'unlinked';
  requestedAt: string;
  decidedAt: string | null;
  customerPhone: string;
}

const FILTERS = [
  { value: 'pending_insurer', label: 'Waiting for you' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'rejected', label: 'Rejected' },
] as const;

/** Customers asking to link a policy. Confirming says the policy is theirs; then the premium and cover are set here. */
export function Requests({ canAct }: { canAct: boolean }) {
  const [filter, setFilter] = useState<string>('pending_insurer');
  const [links, setLinks] = useState<Link[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = () => api<Link[]>(`/insurer/policy-links?status=${filter}`).then(setLinks).catch((e: ApiError) => setError(e.message));
  useEffect(() => {
    setLinks(null);
    setOpen(null);
    load();
  }, [filter]);

  const done = (msg: string) => {
    setFlash(msg);
    setOpen(null);
    load();
  };

  return (
    <>
      <div className="row-between">
        <h1>Policy requests</h1>
        <div className="seg" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => { setFilter(f.value); setFlash(null); }}>{f.label}</button>
          ))}
        </div>
      </div>
      <p className="muted">Customers ask to pay a policy with you through AfyaPay. Confirm only if the policy number belongs to this customer.</p>
      {flash && <p className="ok" role="status">{flash}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!links ? (
        <p className="muted">Loading…</p>
      ) : links.length === 0 ? (
        <p className="card empty muted">Nothing here.</p>
      ) : (
        <div className="table-wrap" role="region" aria-label="Results" tabIndex={0}>
        <table className="grid">
          <thead>
            <tr><th>Policy number</th><th>Customer phone</th><th>Asked</th>{filter !== 'pending_insurer' && <th>Decided</th>}<th><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <Row key={l.id} link={l} canAct={canAct} open={open === l.id} toggle={() => setOpen(open === l.id ? null : l.id)} done={done} showDecided={filter !== 'pending_insurer'} />
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}

function Row({ link: l, canAct, open, toggle, done, showDecided }: { link: Link; canAct: boolean; open: boolean; toggle: () => void; done: (m: string) => void; showDecided: boolean }) {
  const cols = showDecided ? 5 : 4;
  const actionLabel = l.status === 'pending_insurer' ? 'Decide' : l.status === 'confirmed' ? 'Premium and cover' : null;
  return (
    <>
      <tr>
        <td className="mono">{l.policyNumber}</td>
        <td className="mono">{l.customerPhone}</td>
        <td>{when(l.requestedAt)}</td>
        {showDecided && <td>{when(l.decidedAt)}</td>}
        <td className="actions">{canAct && actionLabel && <button className="secondary small" aria-expanded={open} onClick={toggle}>{open ? 'Close' : actionLabel}</button>}</td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={cols}>
            {l.status === 'pending_insurer' ? <Decide link={l} done={done} /> : (
              <div className="forms">
                <PremiumForm link={l} done={done} />
                <CoverForm link={l} done={done} />
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function Decide({ link, done }: { link: Link; done: (m: string) => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const confirm = useSubmit(async () => {
    await api(`/insurer/policy-links/${link.id}/decision`, { method: 'POST', body: { decision: 'confirmed' } });
    done(`Policy ${link.policyNumber} confirmed. Next, set its premium and cover under Confirmed.`);
  });
  const reject = useSubmit(async () => {
    await api(`/insurer/policy-links/${link.id}/decision`, { method: 'POST', body: { decision: 'rejected', reason } });
    done(`Policy ${link.policyNumber} rejected. The customer sees your reason.`);
  });
  const { error } = rejecting ? reject : confirm;
  return (
    <div className="decide">
      {!rejecting ? (
        <div className="button-row">
          <button className="primary inline" disabled={confirm.busy} onClick={() => confirm.submit()}>Confirm, this policy is theirs</button>
          <button className="secondary inline" onClick={() => setRejecting(true)}>Reject</button>
        </div>
      ) : (
        <form onSubmit={reject.submit}>
          <label htmlFor={`reason-${link.id}`}>Reason the customer will see</label>
          <input id={`reason-${link.id}`} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="For example: policy number not found" required />
          <div className="button-row">
            <button className="primary inline danger" disabled={reject.busy || !reason.trim()}>Reject request</button>
            <button type="button" className="secondary inline" onClick={() => setRejecting(false)}>Back</button>
          </div>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

function PremiumForm({ link, done }: { link: Link; done: (m: string) => void }) {
  const [frequency, setFrequency] = useState('monthly');
  const [amount, setAmount] = useState('');
  const [startsOn, setStartsOn] = useState(today());
  const s = useSubmit(async () => {
    await api(`/insurer/policy-links/${link.id}/premium-schedule`, { method: 'POST', body: { frequency, amountMinor: String(BigInt(amount) * 100n), startsOn } });
    done(`Premium for ${link.policyNumber} set: KES ${Number(amount).toLocaleString('en-KE')} ${frequency} from ${startsOn}.`);
  });
  return (
    <form className="subform" onSubmit={s.submit}>
      <h2>Premium</h2>
      <label htmlFor={`freq-${link.id}`}>How often</label>
      <select id={`freq-${link.id}`} value={frequency} onChange={(e) => setFrequency(e.target.value)}>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
        <option value="annual">Yearly</option>
      </select>
      <label htmlFor={`amt-${link.id}`}>Amount each time (whole KES)</label>
      <input id={`amt-${link.id}`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, '').slice(0, 9))} required />
      <label htmlFor={`start-${link.id}`}>Starts on</label>
      <input id={`start-${link.id}`} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} required />
      {s.error && <p className="error" role="alert">{s.error}</p>}
      <button className="primary" disabled={s.busy || !amount || amount === '0'}>Set premium</button>
    </form>
  );
}

function CoverForm({ link, done }: { link: Link; done: (m: string) => void }) {
  const [status, setStatus] = useState('active');
  const [coveredUntil, setCoveredUntil] = useState('');
  const [effectiveOn, setEffectiveOn] = useState(today());
  const [reference, setReference] = useState('');
  const s = useSubmit(async () => {
    await api(`/insurer/policy-links/${link.id}/cover-events`, {
      method: 'POST',
      body: { status, effectiveOn, coveredUntil: status === 'active' ? coveredUntil : undefined, insurerReference: reference.trim() || undefined },
    });
    done(`Cover for ${link.policyNumber} recorded as ${status}${status === 'active' ? ` until ${coveredUntil}` : ''}. The customer sees it as confirmed by you.`);
  });
  return (
    <form className="subform" onSubmit={s.submit}>
      <h2>Cover</h2>
      <p className="hint">Only your team can change cover. Payments never change it.</p>
      <label htmlFor={`cov-${link.id}`}>Cover status</label>
      <select id={`cov-${link.id}`} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="active">Active</option>
        <option value="lapsed">Lapsed</option>
        <option value="ended">Ended</option>
      </select>
      {status === 'active' && (
        <>
          <label htmlFor={`until-${link.id}`}>Covered until</label>
          <input id={`until-${link.id}`} type="date" value={coveredUntil} onChange={(e) => setCoveredUntil(e.target.value)} required />
        </>
      )}
      <label htmlFor={`eff-${link.id}`}>Effective from</label>
      <input id={`eff-${link.id}`} type="date" value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} required />
      <label htmlFor={`ref-${link.id}`}>Your reference (optional)</label>
      <input id={`ref-${link.id}`} value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />
      {s.error && <p className="error" role="alert">{s.error}</p>}
      <button className="primary" disabled={s.busy}>Record cover</button>
    </form>
  );
}
