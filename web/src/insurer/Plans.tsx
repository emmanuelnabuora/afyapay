import { FormEvent, useEffect, useState } from 'react';
import { api, kes, toMinor, when } from '../staff/api';
import { ErrorLine, Table, useAction } from '../staff/ui';

interface Plan {
  id: string; code: string; name: string; coverType: string; summary: string; minHousehold: number; maxHousehold: number;
  baseMonthlyMinor: string; perExtraMemberMinor: string; counties: string[]; inpatientLimitMinor: string | null; outpatientLimitMinor: string | null;
  waitingPeriodDays: number; benefits: string[]; exclusions: string[]; sponsored: boolean; status: 'active' | 'withdrawn'; updatedAt: string;
}

const COVER = { health_individual: 'Health, one person', health_family: 'Health, family', personal_accident: 'Personal accident' } as const;
const shillings = (minor: string | null) => (minor ? String(BigInt(minor) / 100n) : '');

interface Draft {
  code: string; name: string; coverType: keyof typeof COVER; summary: string; minHousehold: number; maxHousehold: number; base: string; perExtra: string;
  allCounties: boolean; counties: string[]; inpatient: string; outpatient: string; waitingPeriodDays: number; benefits: string; exclusions: string; sponsored: boolean;
}

const EMPTY: Draft = { code: '', name: '', coverType: 'health_individual', summary: '', minHousehold: 1, maxHousehold: 1, base: '', perExtra: '0', allCounties: true, counties: [], inpatient: '', outpatient: '', waitingPeriodDays: 0, benefits: '', exclusions: '', sponsored: false };

const toDraft = (p: Plan): Draft => ({
  code: p.code, name: p.name, coverType: p.coverType as Draft['coverType'], summary: p.summary, minHousehold: p.minHousehold, maxHousehold: p.maxHousehold,
  base: shillings(p.baseMonthlyMinor), perExtra: shillings(p.perExtraMemberMinor) || '0', allCounties: p.counties.length === 0, counties: p.counties,
  inpatient: shillings(p.inpatientLimitMinor), outpatient: shillings(p.outpatientLimitMinor), waitingPeriodDays: p.waitingPeriodDays,
  benefits: p.benefits.join('\n'), exclusions: p.exclusions.join('\n'), sponsored: p.sponsored,
});

/** The insurer's own plans in the AfyaPay catalogue: what customers search and compare. */
export function Plans({ canAct }: { canAct: boolean }) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const a = useAction();
  const load = () => api<Plan[]>('/insurer/plans').then(setPlans).catch(() => setPlans([]));
  useEffect(() => {
    load();
  }, []);

  if (editing) return <PlanForm draft={editing} isNew={!plans?.some((p) => p.code === editing.code)} onDone={(msg) => { setEditing(null); setFlash(msg); load(); }} onCancel={() => setEditing(null)} />;

  return (
    <>
      <div className="row-between">
        <h1>Your plans</h1>
        {canAct && <button className="secondary small" onClick={() => { setFlash(null); setEditing({ ...EMPTY }); }}>Add a plan</button>}
      </div>
      <p className="muted">Customers can search and compare these plans and ask you to contact them. They are listed by price for the customer's household. Buying through AfyaPay is not available yet.</p>
      {flash && <p className="ok" role="status">{flash}</p>}
      <ErrorLine error={a.error} />
      {!plans ? <p className="muted">Loading…</p> : plans.length === 0 ? <p className="card empty muted">No plans yet.</p> : (
        <Table head={<tr><th>Code</th><th>Name</th><th>Type</th><th className="num">From</th><th>Status</th><th>Updated</th><th><span className="sr-only">Actions</span></th></tr>}>
          {plans.map((p) => (
            <tr key={p.id}>
              <td className="mono">{p.code}</td>
              <td>{p.name}{p.sponsored && <span className="badge small neutral">Sponsored</span>}</td>
              <td>{COVER[p.coverType as keyof typeof COVER] ?? p.coverType}</td>
              <td className="num">{kes(p.baseMonthlyMinor)}/month</td>
              <td><span className={`badge ${p.status === 'active' ? 'good' : 'neutral'}`}>{p.status === 'active' ? 'Listed' : 'Withdrawn'}</span></td>
              <td>{when(p.updatedAt)}</td>
              <td className="actions">
                {canAct && <button className="secondary small" onClick={() => { setFlash(null); setEditing(toDraft(p)); }}>{p.status === 'active' ? 'Edit' : 'Edit and list again'}</button>}
                {canAct && p.status === 'active' && (
                  <button className="secondary small" disabled={a.busy} onClick={() => a.run(async () => { await api(`/insurer/plans/${p.code}/withdraw`, { method: 'POST' }); setFlash(`${p.name} withdrawn. Customers no longer see it.`); load(); })}>Withdraw</button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

function PlanForm({ draft, isNew, onDone, onCancel }: { draft: Draft; isNew: boolean; onDone: (m: string) => void; onCancel: () => void }) {
  const [d, setD] = useState(draft);
  const [counties, setCounties] = useState<string[]>([]);
  const a = useAction();
  useEffect(() => {
    api<string[]>('/plans/counties').then(setCounties).catch(() => undefined);
  }, []);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const money = (s: string) => (s ? toMinor(s) : null);

  function submit(e: FormEvent) {
    a.run(async () => {
      if (!money(d.base)) throw { message: 'Give the monthly price for one person in whole KES.' };
      await api('/insurer/plans', {
        method: 'POST',
        body: {
          code: d.code, name: d.name, coverType: d.coverType, summary: d.summary, minHousehold: d.minHousehold, maxHousehold: d.maxHousehold,
          baseMonthlyMinor: money(d.base), perExtraMemberMinor: money(d.perExtra || '0') ?? '0', counties: d.allCounties ? [] : d.counties,
          inpatientLimitMinor: money(d.inpatient), outpatientLimitMinor: money(d.outpatient), waitingPeriodDays: d.waitingPeriodDays,
          benefits: lines(d.benefits), exclusions: lines(d.exclusions), sponsored: d.sponsored,
        },
      });
      onDone(`${d.name} is listed. Customers see it in search straight away.`);
    }, e);
  }

  const whole = (k: 'base' | 'perExtra' | 'inpatient' | 'outpatient', label: string, required = false) => (
    <div>
      <label htmlFor={`p-${k}`}>{label}</label>
      <input id={`p-${k}`} inputMode="numeric" value={d[k]} required={required} onChange={(e) => set(k, e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder={required ? '' : 'Not stated'} />
    </div>
  );
  const range = Array.from({ length: 12 }, (_, i) => i + 1);

  return (
    <form className="card plan-form" onSubmit={submit}>
      <h1>{isNew ? 'Add a plan' : `Edit ${draft.name}`}</h1>
      <p className="muted">Customers see these details as supplied by you. Prices are your listed prices; you confirm the final price with the customer.</p>
      <div className="two">
        <div>
          <label htmlFor="p-code">Your plan code</label>
          <input id="p-code" value={d.code} disabled={!isNew} maxLength={30} onChange={(e) => set('code', e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))} required />
        </div>
        <div>
          <label htmlFor="p-type">Type of cover</label>
          <select id="p-type" value={d.coverType} onChange={(e) => set('coverType', e.target.value as Draft['coverType'])}>
            {Object.entries(COVER).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>
      <label htmlFor="p-name">Plan name</label>
      <input id="p-name" value={d.name} minLength={3} maxLength={80} onChange={(e) => set('name', e.target.value)} required />
      <label htmlFor="p-summary">Short summary</label>
      <textarea id="p-summary" value={d.summary} minLength={10} maxLength={400} onChange={(e) => set('summary', e.target.value)} required />
      <div className="two">
        <div>
          <label htmlFor="p-min">Smallest household</label>
          <select id="p-min" value={d.minHousehold} onChange={(e) => { const n = Number(e.target.value); setD({ ...d, minHousehold: n, maxHousehold: Math.max(n, d.maxHousehold) }); }}>{range.map((n) => <option key={n}>{n}</option>)}</select>
        </div>
        <div>
          <label htmlFor="p-max">Largest household</label>
          <select id="p-max" value={d.maxHousehold} onChange={(e) => set('maxHousehold', Number(e.target.value))}>{range.filter((n) => n >= d.minHousehold).map((n) => <option key={n}>{n}</option>)}</select>
        </div>
      </div>
      <div className="two">
        {whole('base', 'Monthly price for one person (KES)', true)}
        {whole('perExtra', 'Added for each extra person (KES)')}
      </div>
      <div className="two">
        {whole('inpatient', 'Inpatient limit (KES)')}
        {whole('outpatient', 'Outpatient limit (KES)')}
      </div>
      <label htmlFor="p-wait">Waiting period (days)</label>
      <input id="p-wait" inputMode="numeric" value={d.waitingPeriodDays} onChange={(e) => set('waitingPeriodDays', Math.min(730, Number(e.target.value.replace(/\D/g, '') || 0)))} />
      <label htmlFor="p-benefits">What it covers (one per line)</label>
      <textarea id="p-benefits" value={d.benefits} onChange={(e) => set('benefits', e.target.value)} />
      <label htmlFor="p-exclusions">What it does not cover (one per line)</label>
      <textarea id="p-exclusions" value={d.exclusions} onChange={(e) => set('exclusions', e.target.value)} />
      <label className="check"><input type="checkbox" checked={d.allCounties} onChange={(e) => set('allCounties', e.target.checked)} /> Offered in every county</label>
      {!d.allCounties && (
        <div className="county-grid" role="group" aria-label="Counties">
          {counties.map((c) => (
            <label key={c}><input type="checkbox" checked={d.counties.includes(c)} onChange={(e) => set('counties', e.target.checked ? [...d.counties, c] : d.counties.filter((x) => x !== c))} /> {c}</label>
          ))}
        </div>
      )}
      <label className="check"><input type="checkbox" checked={d.sponsored} onChange={(e) => set('sponsored', e.target.checked)} /> Sponsored</label>
      <p className="hint">A sponsored plan shows a "Sponsored" label. It never moves the plan up the list: plans are always ordered by price.</p>
      <ErrorLine error={a.error} />
      <div className="button-row">
        <button className="primary inline" disabled={a.busy || (!d.allCounties && d.counties.length === 0)}>{isNew ? 'List this plan' : 'Update plan'}</button>
        <button type="button" className="secondary inline" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
