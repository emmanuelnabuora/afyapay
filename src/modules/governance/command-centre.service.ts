import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { GovernanceService } from './governance.service';

/**
 * One read for the staff command centre (Step 5 design): today's payments,
 * work waiting on people, platform health and launch readiness. Read-only;
 * every figure links back to a list staff can open.
 */
@Injectable()
export class CommandCentreService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly gov: GovernanceService,
  ) {}

  async summary() {
    const q = async <T>(sql: string, params: unknown[] = []) => (await this.pool.query(sql, params)).rows as T[];
    const [payments, exceptions, coverBatches, documents, approvals, jobs, outbox, notifications, lastCheck] = await Promise.all([
      q<{ status: string; count: number; amount_minor: string }>(
        `select status, count(*)::int as count, coalesce(sum(amount_minor), 0)::text as amount_minor
           from payment.payment_intent
          where (created_at at time zone 'Africa/Nairobi')::date = (now() at time zone 'Africa/Nairobi')::date
          group by status order by status`,
      ),
      q<{ open: number; overdue: number }>("select count(*)::int as open, count(*) filter (where due_at < now())::int as overdue from reconciliation.exception where status = 'open'"),
      q<{ n: number }>("select count(*)::int as n from policy.cover_batch where status = 'proposed'"),
      q<{ n: number }>("select count(*)::int as n from reconciliation.statement_document where status = 'awaiting_review'"),
      q<{ kind: string; n: number }>("select kind, count(*)::int as n from governance.approval_request where status = 'proposed' group by kind order by kind"),
      q<{ dead: number; late: number }>("select count(*) filter (where status = 'dead')::int as dead, count(*) filter (where status = 'queued' and run_at < now() - interval '5 minutes')::int as late from platform.job"),
      q<{ n: number }>("select count(*)::int as n from platform.outbox_event where published_at is null and created_at < now() - interval '5 minutes'"),
      q<{ failed: number }>("select count(*)::int as failed from notification.message where status = 'failed' and created_at > now() - interval '24 hours'"),
      q<{ occurred_at: Date; after_state: { intact: boolean; checked: number } }>("select occurred_at, after_state from governance.audit_event where action = 'audit.verified' order by seq desc limit 1"),
    ]);
    const needsReview = payments.find((p) => p.status === 'needs_review')?.count ?? 0;
    const gates = await this.gov.gates();
    const settings = await this.gov.settings();
    return {
      generatedAt: new Date().toISOString(),
      paymentsToday: {
        byStatus: payments.map((p) => ({ status: p.status, count: p.count, amountMinor: p.amount_minor, currency: 'KES' })),
        confirmed: { count: payments.find((p) => p.status === 'confirmed')?.count ?? 0, amountMinor: payments.find((p) => p.status === 'confirmed')?.amount_minor ?? '0', currency: 'KES' },
      },
      waitingOnPeople: {
        paymentsNeedingReview: needsReview,
        reconciliationExceptions: exceptions[0],
        coverBatchesAwaitingApprover: coverBatches[0].n,
        pdfStatementsAwaitingReview: documents[0].n,
        approvalRequests: Object.fromEntries(approvals.map((a) => [a.kind, a.n])),
      },
      platformHealth: {
        deadJobs: jobs[0].dead,
        lateJobs: jobs[0].late,
        outboxBacklog: outbox[0].n,
        failedMessages24h: notifications[0].failed,
        lastAuditCheck: lastCheck[0] ? { at: lastCheck[0].occurred_at, intact: lastCheck[0].after_state.intact } : null,
      },
      launchReadiness: {
        gates: gates.map((g) => ({ code: g.code, title: g.title, neededFor: g.neededFor, status: g.status })),
        pilotGatesOpen: gates.filter((g) => g.neededFor === 'pilot' && g.status === 'open').map((g) => g.code),
        liveMoney: settings.liveMoney,
      },
    };
  }
}
