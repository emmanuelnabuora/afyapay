import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, kes } from '../api';
import { coverLabel, filters, limit, monthly, waiting } from '../plans';
import type { BuyingStatus, Plan, PlanInterest } from '../types';
import { BuyingNotice } from './FindPlans';
import { SignIn } from './SignIn';

interface Props {
  planId: string;
  signedIn: boolean;
  onSignedIn: () => void;
  go: (to: string) => void;
}

export function PlanDetail({ planId, signedIn, onSignedIn, go }: Props) {
  const [household, setHousehold] = useState(filters.householdSize);
  const [data, setData] = useState<{ buying: BuyingStatus; plan: Plan } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ buying: BuyingStatus; plan: Plan }>(`/plans/${planId}?householdSize=${household}`, { auth: false })
      .then(setData)
      .catch((e: ApiError) => setError(e.message));
  }, [planId, household]);

  if (error && !data) return <p className="error" role="alert">{error}</p>;
  if (!data) return <p className="muted">Loading plan…</p>;
  const p = data.plan;

  return (
    <>
      <button className="link-button back" onClick={() => go('/plans')}>← All plans</button>
      <section className="card plan">
        <header>
          <div>
            <h1>{p.name}</h1>
            <span className="muted">{p.insurer.name} · {coverLabel(p.coverType)}</span>
          </div>
          {p.label && <span className="badge sponsored">{p.label}</span>}
        </header>
        <p className="price">{monthly(p)}</p>
        <p className="hint">For {household === 1 ? 'one person' : `${household} people`}. This is the insurer's listed price; the insurer confirms the final price.</p>
        <p>{p.summary}</p>
        <dl className="receipt-lines">
          <div><dt>Inpatient limit</dt><dd>{limit(p.inpatientLimitMinor)}</dd></div>
          <div><dt>Outpatient limit</dt><dd>{limit(p.outpatientLimitMinor)}</dd></div>
          <div><dt>Waiting period</dt><dd>{waiting(p.waitingPeriodDays)}</dd></div>
          <div><dt>Household size</dt><dd>{p.household.min === p.household.max ? p.household.min : `${p.household.min} to ${p.household.max}`}</dd></div>
          <div><dt>Counties</dt><dd>{p.counties.length ? p.counties.join(', ') : 'All counties'}</dd></div>
        </dl>
        {p.benefits.length > 0 && (
          <>
            <h2>What it covers</h2>
            <ul className="list">{p.benefits.map((b) => <li key={b}>{b}</li>)}</ul>
          </>
        )}
        {p.exclusions.length > 0 && (
          <>
            <h2>What it does not cover</h2>
            <ul className="list">{p.exclusions.map((b) => <li key={b}>{b}</li>)}</ul>
          </>
        )}
        <p className="hint">{p.source}.</p>
      </section>
      <BuyingNotice buying={data.buying} />
      <RegisterInterest plan={p} household={household} setHousehold={setHousehold} signedIn={signedIn} onSignedIn={onSignedIn} />
    </>
  );
}

function RegisterInterest({ plan, household, setHousehold, signedIn, onSignedIn }: { plan: Plan; household: number; setHousehold: (n: number) => void; signedIn: boolean; onSignedIn: () => void }) {
  const [wantsSignIn, setWantsSignIn] = useState(false);
  const [counties, setCounties] = useState<string[]>([]);
  const [county, setCounty] = useState(filters.county);
  const [consent, setConsent] = useState<{ version: string; text: string } | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [existing, setExisting] = useState<PlanInterest | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!signedIn) return;
    api<{ version: string; text: string }>(`/plans/${plan.id}/interest-consent`, { auth: false }).then(setConsent).catch((e: ApiError) => setError(e.message));
    api<string[]>('/plans/counties', { auth: false }).then(setCounties).catch(() => setCounties([]));
    api<PlanInterest[]>('/me/plan-interests').then((list) => setExisting(list.find((i) => i.plan.id === plan.id && i.status !== 'closed') ?? null)).catch(() => undefined);
  }, [signedIn, plan.id]);

  if (!signedIn) {
    return wantsSignIn ? (
      <SignIn onSignedIn={onSignedIn} />
    ) : (
      <section className="card">
        <h2>Interested?</h2>
        <p className="muted">Sign in with your phone number to ask {plan.insurer.name} to contact you about this plan.</p>
        <button className="primary" onClick={() => setWantsSignIn(true)}>Sign in to continue</button>
      </section>
    );
  }

  if (done || existing) {
    return (
      <section className="card done" role="status">
        <h2>Request sent</h2>
        <p>{done ?? `You already asked ${plan.insurer.name} about this plan. They will contact you.`}</p>
        {existing && <p className="hint">Asked for {existing.householdSize === 1 ? 'one person' : `${existing.householdSize} people`} at {kes(existing.quotedMonthlyMinor)} a month.</p>}
      </section>
    );
  }

  const fits = household >= plan.household.min && household <= plan.household.max;
  const sizes = Array.from({ length: plan.household.max - plan.household.min + 1 }, (_, i) => plan.household.min + i);
  const countyChoices = plan.counties.length ? plan.counties : counties;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message: string }>('/me/plan-interests', { method: 'POST', body: { planId: plan.id, householdSize: household, county: county || null, consent: true, consentTextVersion: consent!.version } });
      setDone(r.message);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Ask {plan.insurer.name} to contact you</h2>
      <label htmlFor="i-household">People to cover</label>
      <select id="i-household" value={fits ? household : ''} onChange={(e) => setHousehold(Number(e.target.value))} required>
        {!fits && <option value="">Choose</option>}
        {sizes.map((n) => <option key={n} value={n}>{n === 1 ? 'Just me' : `${n} people`}</option>)}
      </select>
      <label htmlFor="i-county">Your county{plan.counties.length ? '' : ' (optional)'}</label>
      <select id="i-county" value={county} onChange={(e) => setCounty(e.target.value)} required={plan.counties.length > 0}>
        <option value="">{plan.counties.length ? 'Choose your county' : 'Prefer not to say'}</option>
        {countyChoices.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {consent && (
        <label className="consent">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>{consent.text}</span>
        </label>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy || !agreed || !fits}>{busy ? 'Sending…' : `Ask ${plan.insurer.name} to contact me`}</button>
    </form>
  );
}
