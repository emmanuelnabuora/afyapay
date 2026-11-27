import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { Policy, PolicyLink } from '../types';

const tone = (state: string) =>
  ['payment_succeeded', 'fully_paid', 'active'].includes(state) ? 'good' : ['payment_failed', 'behind_schedule', 'lapsed', 'ended'].includes(state) ? 'bad' : ['stale', 'payment_pending'].includes(state) ? 'warn' : 'neutral';

/** The three tracks, each in its own words: money (M-Pesa), premium (the plan), cover (the insurer only). */
function Tracks({ p }: { p: Policy }) {
  return (
    <dl className="tracks">
      <div className={`track ${tone(p.money.state)}`}>
        <dt>Money</dt>
        <dd>{p.money.label}</dd>
      </div>
      <div className={`track ${tone(p.premium.state)}`}>
        <dt>Premium</dt>
        <dd>{p.premium.label}</dd>
      </div>
      <div className={`track ${tone(p.cover.state)}`}>
        <dt>Cover</dt>
        <dd>{p.cover.label}</dd>
      </div>
    </dl>
  );
}

export function Home({ go, onSignedOut }: { go: (to: string) => void; onSignedOut: () => void }) {
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [links, setLinks] = useState<PolicyLink[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api<{ policies: Policy[] }>('/me/policies'), api<PolicyLink[]>('/me/policy-links')])
      .then(([p, l]) => {
        setPolicies(p.policies);
        setLinks(l.filter((x) => x.status !== 'confirmed' && x.status !== 'unlinked'));
      })
      .catch((err: ApiError) => (err.status === 401 ? onSignedOut() : setError(err.message)));
  }, []);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!policies) return <p className="muted">Loading your policies…</p>;

  return (
    <>
      <div className="row-between">
        <h1>Your policies</h1>
        <button className="secondary small" onClick={() => go('/link')}>Link a policy</button>
      </div>
      {policies.length === 0 && links.length === 0 && (
        <section className="card empty">
          <h2>No policies yet</h2>
          <p className="muted">Link a policy you already have with your insurer, then pay your premium here with M-Pesa.</p>
          <button className="primary" onClick={() => go('/link')}>Link a policy</button>
        </section>
      )}
      {policies.map((p) => (
        <section className="card policy" key={p.policyLinkId}>
          <header>
            <h2>{p.insurer.name}</h2>
            <span className="policy-no">{p.policyNumber}</span>
          </header>
          <Tracks p={p} />
          <button className="primary" onClick={() => go(`/pay/${p.policyLinkId}`)}>Pay with M-Pesa</button>
        </section>
      ))}
      {links.map((l) => (
        <section className="card policy waiting" key={l.id}>
          <header>
            <h2>{l.insurer.name}</h2>
            <span className="policy-no">{l.policyNumber}</span>
          </header>
          <p className="muted">
            {l.status === 'pending_insurer'
              ? `Waiting for ${l.insurer.name} to confirm this policy is yours.`
              : `${l.insurer.name} could not confirm this policy${l.rejectionReason ? `: ${l.rejectionReason}` : '.'}`}
          </p>
        </section>
      ))}
    </>
  );
}
