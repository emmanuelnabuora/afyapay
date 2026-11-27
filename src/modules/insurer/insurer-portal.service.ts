import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { maskPhone } from '../identity/phone';
import { PolicyLinkService } from '../policy/policy-link.service';
import { InsurerSource, PolicyTracksService } from '../policy/policy-tracks.service';
import { Frequency } from '../policy/tracks';
import { InsurerClaims } from './insurer-auth.service';
import { InsurerScope } from './insurer-scope';

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);

/**
 * What insurer staff can see and do. Every call runs inside InsurerScope, so
 * the database itself limits it to the signed-in user's insurer.
 */
@Injectable()
export class InsurerPortalService {
  constructor(
    private readonly scope: InsurerScope,
    private readonly links: PolicyLinkService,
    private readonly tracks: PolicyTracksService,
  ) {}

  /** Who is signed in, with their insurer's name for the portal header. */
  async me(user: InsurerClaims) {
    const insurer = await this.scope.run(user.ins, async (tx) => (await tx.query<{ code: string; name: string }>('select code, name from insurer.insurer where id = $1', [user.ins])).rows[0]);
    return { userId: user.sub, insurerId: user.ins, role: user.role, insurer: insurer ?? null };
  }

  async listLinks(user: InsurerClaims, status?: unknown) {
    const filter = typeof status === 'string' && ['pending_insurer', 'confirmed', 'rejected', 'unlinked'].includes(status) ? status : null;
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query(
        `select l.id, l.policy_number, l.status, l.requested_at, l.decided_at, c.phone_e164
           from policy.policy_link l join identity.customer c on c.id = l.customer_id
          where ($1::text is null or l.status = $1)
          order by l.requested_at desc limit 500`,
        [filter],
      );
      // The customer agreed to share their phone with this insurer; the list still shows it masked.
      return rows.map((r) => ({ id: r.id, policyNumber: r.policy_number, status: r.status, requestedAt: r.requested_at, decidedAt: r.decided_at, customerPhone: maskPhone(r.phone_e164) }));
    });
  }

  async decideLink(user: InsurerClaims, linkId: string, body: { decision?: unknown; reason?: unknown }) {
    if (!isUuid(linkId)) throw fail(HttpStatus.NOT_FOUND, 'policy.link_not_found', 'Link not found.');
    if (body.decision !== 'confirmed' && body.decision !== 'rejected') throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'policy.decision_invalid', 'Decision must be confirmed or rejected.');
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : undefined;
    return this.scope.run(user.ins, (tx) => this.links.decide(linkId, body.decision as 'confirmed' | 'rejected', { insurerId: user.ins, userId: user.sub }, reason, tx));
  }

  async setPremiumSchedule(user: InsurerClaims, linkId: string, body: { frequency?: unknown; amountMinor?: unknown; startsOn?: unknown }) {
    if (!isUuid(linkId)) throw fail(HttpStatus.NOT_FOUND, 'policy.link_not_found', 'Link not found.');
    const amount = typeof body.amountMinor === 'string' || typeof body.amountMinor === 'number' ? String(body.amountMinor) : '';
    if (!/^[0-9]{1,12}$/.test(amount)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'premium.amount_invalid', 'amountMinor must be a whole number of cents.');
    await this.scope.run(user.ins, (tx) =>
      this.tracks.setPremiumSchedule(linkId, this.actor(user), { frequency: body.frequency as Frequency, amountMinor: BigInt(amount), startsOn: String(body.startsOn ?? '') }, tx),
    );
    return { policyLinkId: linkId, frequency: body.frequency, amountMinor: amount, startsOn: body.startsOn };
  }

  async recordCover(user: InsurerClaims, linkId: string, body: { status?: unknown; coveredUntil?: unknown; effectiveOn?: unknown; insurerReference?: unknown }) {
    if (!isUuid(linkId)) throw fail(HttpStatus.NOT_FOUND, 'policy.link_not_found', 'Link not found.');
    const event = {
      status: body.status as 'active' | 'lapsed' | 'ended',
      coveredUntil: typeof body.coveredUntil === 'string' ? body.coveredUntil : undefined,
      effectiveOn: String(body.effectiveOn ?? ''),
      insurerReference: typeof body.insurerReference === 'string' ? body.insurerReference.slice(0, 80) : undefined,
    };
    await this.scope.run(user.ins, (tx) => this.tracks.recordCoverEvent(linkId, this.actor(user), event, tx));
    return { policyLinkId: linkId, ...event };
  }

  /** Payments made to this insurer's paybill, newest first. */
  async listPayments(user: InsurerClaims, query: { from?: unknown; to?: unknown }) {
    const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query(
        `select p.id, l.policy_number, p.amount_minor::text as amount_minor, p.currency, p.status, p.failure_code, p.created_at,
                r.mpesa_receipt, r.created_at as confirmed_at
           from payment.payment_intent p
           join policy.policy_link l on l.id = p.policy_link_id
           left join payment.payment_result r on r.payment_intent_id = p.id and r.result_code = 0
          where ($1::date is null or p.created_at >= ($1::date)::timestamp at time zone 'Africa/Nairobi')
            and ($2::date is null or p.created_at < ($2::date + 1)::timestamp at time zone 'Africa/Nairobi')
          order by p.created_at desc limit 1000`,
        [date(query.from), date(query.to)],
      );
      return rows.map((r) => ({
        id: r.id,
        policyNumber: r.policy_number,
        amountMinor: r.amount_minor,
        currency: r.currency,
        status: r.status,
        failureCode: r.failure_code,
        mpesaReceipt: r.mpesa_receipt,
        createdAt: r.created_at,
        confirmedAt: r.confirmed_at,
      }));
    });
  }

  private actor(user: InsurerClaims): { insurerId: string; userId: string; source: InsurerSource } {
    return { insurerId: user.ins, userId: user.sub, source: 'insurer_portal' };
  }
}
