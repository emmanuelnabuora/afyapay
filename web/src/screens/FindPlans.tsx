import { FormEvent, useEffect, useState } from 'react';
import { api, ApiError, toMinor } from '../api';
import { compareIds, COVER_TYPES, coverLabel, filters, MAX_COMPARE, monthly } from '../plans';
import type { BuyingStatus, Plan } from '../types';

interface SearchResult {
  rankedBy: string;
  buying: BuyingStatus;
  plans: Plan[];
}

export function BuyingNotice({ buying }: { buying: BuyingStatus | null }) {
  return buying?.notice ? <p className="notice" role="note">{buying.notice}</p> : null;
}

export function FindPlans({ go }: { go: (to: string) => void }) {
  const [form, setForm] = useState({ ...filters });
  const [counties, setCounties] = useState<string[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [picked, setPicked] = useState<string[]>([...compareIds]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    setError(null);
    const q = new URLSearchParams({ householdSize: String(form.householdSize) });
    if (form.coverType) q.set('coverType', form.coverType);
    if (form.county) q.set('county', form.county);
    if (form.budgetKes) q.set('budgetMinor', String(toMinor(Number(form.budgetKes))));
    try {
      setResult(await api<SearchResult>(`/plans?${q}`, { auth: false }));
      Object.assign(filters, form);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    api<string[]>('/plans/counties', { auth: false }).then(setCounties).catch(() => setCounties([]));
    search();
  }, []);

  function toggle(id: string) {
    if (compareIds.has(id)) compareIds.delete(id);
    else if (compareIds.size < MAX_COMPARE) compareIds.add(id);
    setPicked([...compareIds]);
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    search();
  };
  const set = (k: keyof typeof form, v: string | number) => setForm({ ...form, [k]: v });

  return (
    <>
      <h1>Find insurance</h1>
      <p className="muted">Compare plans that insurers offer, then ask an insurer to contact you.</p>
      <BuyingNotice buying={result?.buying ?? null} />
      <form className="card filters" onSubmit={submit}>
        <label htmlFor="cover">Type of cover</label>
        <select id="cover" value={form.coverType} onChange={(e) => set('coverType', e.target.value)}>
          <option value="">Any type</option>
          {COVER_TYPES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <div className="two">
          <div>
            <label htmlFor="household">People to cover</label>
            <select id="household" value={form.householdSize} onChange={(e) => set('householdSize', Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n === 1 ? 'Just me' : `${n} people`}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="budget">Most per month (KES)</label>
            <input id="budget" inputMode="numeric" pattern="[0-9]*" placeholder="Any" value={form.budgetKes} onChange={(e) => set('budgetKes', e.target.value.replace(/\D/g, '').slice(0, 7))} />
          </div>
        </div>
        <label htmlFor="county">County</label>
        <select id="county" value={form.county} onChange={(e) => set('county', e.target.value)}>
          <option value="">Any county</option>
          {counties.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <button className="primary" disabled={busy}>{busy ? 'Searching…' : 'Show plans'}</button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}
      {result && (
        <>
          <p className="hint" aria-live="polite">
            {result.plans.length === 0 ? 'No plans match. Try a higher budget or another county.' : `${result.plans.length} ${result.plans.length === 1 ? 'plan' : 'plans'}. ${result.rankedBy}`}
          </p>
          {result.plans.map((p) => (
            <section className="card plan" key={p.id}>
              <header>
                <div>
                  <h2>{p.name}</h2>
                  <span className="muted">{p.insurer.name} · {coverLabel(p.coverType)}</span>
                </div>
                {p.label && <span className="badge sponsored">{p.label}</span>}
              </header>
              <p className="price">{monthly(p)}</p>
              <p>{p.summary}</p>
              <div className="plan-actions">
                <button className="secondary small" onClick={() => go(`/plans/${p.id}`)}>See details</button>
                <label className="compare-pick">
                  <input type="checkbox" checked={picked.includes(p.id)} disabled={!picked.includes(p.id) && picked.length >= MAX_COMPARE} onChange={() => toggle(p.id)} />
                  Compare
                </label>
              </div>
            </section>
          ))}
        </>
      )}
      {picked.length > 0 && (
        <div className="compare-bar">
          <span>{picked.length} of {MAX_COMPARE} picked</span>
          <button className="primary" disabled={picked.length < 2} onClick={() => go(`/compare/${picked.join(',')}`)}>
            {picked.length < 2 ? 'Pick one more to compare' : 'Compare plans'}
          </button>
        </div>
      )}
    </>
  );
}
