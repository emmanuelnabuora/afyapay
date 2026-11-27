import { useEffect, useState } from 'react';
import { api, ApiError, kes, when } from '../staff/api';
import { ErrorLine } from '../staff/ui';
import type { Gate } from './types';

interface Summary {
  generatedAt: string;
  paymentsToday: { byStatus: { status: string; count: number; amountMinor: string }[]; confirmed: { count: number; amountMinor: string } };
  waitingOnPeople: { paymentsNeedingReview: number; reconciliationExceptions: { open: number; overdue: number }; coverBatchesAwaitingApprover: number; pdfStatementsAwaitingReview: number; approvalRequests: Record<string, number> };
  platformHealth: { deadJobs: number; lateJobs: number; outboxBacklog: number; failedMessages24h: number; lastAuditCheck: { intact: boolean; at: string } | null };
  launchReadiness: { gates: Gate[]; pilotGatesOpen: string[]; liveMoney: { switchedOn: boolean; allowed: boolean; gatesStillOpen: string[] } };
}

const Stat = ({ label, value, tone }: { label: string; value: string | number; tone?: 'bad' | 'warn' }) => (
  <div className={tone && value !== 0 ? `stat-${tone}` : undefined}><dt>{label}</dt><dd>{value}</dd></div>
);

/** The command centre: today's payments, what is waiting on a person, platform health and launch readiness. */
export function Overview() {
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<Summary>('/admin/command-centre').then(setS).catch((e: ApiError) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (error) return <ErrorLine error={error} />;
  if (!s) return <p className="muted">Loading…</p>;
  const w = s.waitingOnPeople;
  const approvalsWaiting = Object.values(w.approvalRequests).reduce((a, b) => a + b, 0);
  const lm = s.launchReadiness.liveMoney;
  return (
    <>
      <div className="row-between">
        <h1>Overview</h1>
        <span className="hint">Updated {when(s.generatedAt)}. Refreshes every minute.</span>
      </div>
      <h2>Payments today (Nairobi)</h2>
      <dl className="stats">
        <Stat label="Paid to insurers" value={kes(s.paymentsToday.confirmed.amountMinor)} />
        <Stat label="Paid payments" value={s.paymentsToday.confirmed.count} />
        <Stat label="Failed or not completed" value={s.paymentsToday.byStatus.filter((b) => ['failed', 'expired'].includes(b.status)).reduce((a, b) => a + b.count, 0)} tone="warn" />
      </dl>
      <h2>Waiting on a person</h2>
      <dl className="stats">
        <Stat label="Payments being checked" value={w.paymentsNeedingReview} tone="warn" />
        <Stat label="Insurer mismatches open" value={w.reconciliationExceptions.open} />
        <Stat label="Mismatches overdue" value={w.reconciliationExceptions.overdue} tone="bad" />
        <Stat label="Cover files awaiting approver" value={w.coverBatchesAwaitingApprover} />
        <Stat label="PDF statements to type up" value={w.pdfStatementsAwaitingReview} />
        <Stat label="Approval requests" value={approvalsWaiting} tone="warn" />
      </dl>
      <h2>Platform health</h2>
      <dl className="stats">
        <Stat label="Failed jobs" value={s.platformHealth.deadJobs} tone="bad" />
        <Stat label="Late jobs" value={s.platformHealth.lateJobs} tone="warn" />
        <Stat label="Outbox backlog" value={s.platformHealth.outboxBacklog} tone="warn" />
        <Stat label="Failed messages (24 h)" value={s.platformHealth.failedMessages24h} tone="warn" />
        <Stat label="Last audit check" value={s.platformHealth.lastAuditCheck ? `${s.platformHealth.lastAuditCheck.intact ? 'Intact' : 'Broken'}, ${when(s.platformHealth.lastAuditCheck.at)}` : 'Never run'} />
      </dl>
      <h2>Launch readiness</h2>
      <p className={lm.switchedOn ? 'ok' : 'notice'}>
        {lm.switchedOn ? 'Live money is switched on.' : `Live money is off. ${lm.gatesStillOpen.length ? `It cannot be switched on until gates ${lm.gatesStillOpen.join(', ')} are closed.` : 'All pilot gates are closed; switching it on needs an approved request.'}`}
      </p>
      <ul className="gate-chips">
        {s.launchReadiness.gates.map((g) => (
          <li key={g.code}><a href={`#/gates/${g.code}`} className={`badge ${g.status === 'closed' ? 'good' : g.neededFor === 'pilot' ? 'warn' : 'neutral'}`}>{g.code} {g.title}: {g.status}</a></li>
        ))}
      </ul>
    </>
  );
}
