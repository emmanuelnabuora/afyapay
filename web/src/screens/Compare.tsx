import { useEffect, useState } from 'react';
import { api, ApiError, kes } from '../api';
import { compareIds, filters, limit } from '../plans';
import type { BuyingStatus, Plan } from '../types';
import { BuyingNotice } from './FindPlans';

interface CompareResult {
  householdSize: number;
  buying: BuyingStatus;
  plans: Plan[];
  rows: { label: string; values: (string | number | boolean | null)[] }[];
}

const MONEY_ROWS = new Set(['Monthly price for your household', 'Inpatient limit', 'Outpatient limit']);

function cell(label: string, v: string | number | boolean | null) {
  if (label === 'Sponsored') return v ? 'Yes' : 'No';
  if (label === 'Waiting period (days)') return v === 0 ? 'None' : `${v} days`;
  if (label === 'Monthly price for your household') return v === null ? 'Not for this household' : kes(v as string);
  if (MONEY_ROWS.has(label)) return limit(v as string | null);
  return String(v);
}

export function Compare({ ids, go }: { ids: string; go: (to: string) => void }) {
  const [data, setData] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<CompareResult>(`/plans/compare?ids=${encodeURIComponent(ids)}&householdSize=${filters.householdSize}`, { auth: false })
      .then(setData)
      .catch((e: ApiError) => setError(e.message));
  }, [ids]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!data) return <p className="muted">Loading comparison…</p>;

  return (
    <>
      <button className="link-button back" onClick={() => go('/plans')}>← All plans</button>
      <h1>Compare plans</h1>
      <p className="muted">Prices are for {data.householdSize === 1 ? 'one person' : `${data.householdSize} people`}, as listed by each insurer.</p>
      <BuyingNotice buying={data.buying} />
      <div className="compare-scroll" role="region" aria-label="Plan comparison" tabIndex={0}>
        <table className="compare">
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Detail</span></th>
              {data.plans.map((p) => (
                <th scope="col" key={p.id}>
                  {p.name}
                  {p.label && <span className="badge sponsored">{p.label}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label.replace(' (days)', '')}</th>
                {r.values.map((v, i) => <td key={i}>{cell(r.label, v)}</td>)}
              </tr>
            ))}
            <tr>
              <th scope="row">Covers</th>
              {data.plans.map((p) => <td key={p.id}>{p.benefits.join(', ') || 'Not stated'}</td>)}
            </tr>
            <tr>
              <th scope="row">Does not cover</th>
              {data.plans.map((p) => <td key={p.id}>{p.exclusions.join(', ') || 'Not stated'}</td>)}
            </tr>
            <tr>
              <th scope="row"><span className="sr-only">Details</span></th>
              {data.plans.map((p) => (
                <td key={p.id}><button className="secondary small" onClick={() => go(`/plans/${p.id}`)}>See details</button></td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <button className="secondary" onClick={() => { compareIds.clear(); go('/plans'); }}>Clear and pick again</button>
    </>
  );
}
