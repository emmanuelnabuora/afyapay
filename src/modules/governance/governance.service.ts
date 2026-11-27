import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { STAFF_ROLES, StaffRole } from './staff-auth.service';
import type { StaffUser } from './staff-auth.guard';
import { SYNTHETIC_STAFF_DOMAIN } from '../insurer/insurer-auth.service';

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PILOT_GATES_FOR_LIVE_MONEY = ['G1', 'G2', 'G3', 'G4', 'G5'];
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

export interface UploadedEvidence {
  originalname: string;
  buffer: Buffer;
}

type Kind = 'role_grant' | 'role_revoke' | 'setting_change' | 'customer_unmask' | 'account_action' | 'insurer_user_add';
export type AccountType = 'staff_user' | 'insurer_user';
export type AccountAction = 'reset_authenticator' | 'reactivate';
const ACCOUNT_TABLE: Record<AccountType, string> = { staff_user: 'governance.staff_user', insurer_user: 'insurer.insurer_user' };
const isAccountType = (t: unknown): t is AccountType => t === 'staff_user' || t === 'insurer_user';

/** A rule the database refused (raised with errcode P0001) becomes a clear 403 instead of a 500. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'P0001') throw fail(HttpStatus.FORBIDDEN, 'governance.refused', e.message ?? 'Refused.');
    throw err;
  }
}

function evidenceType(buf: Buffer): 'application/pdf' | 'image/png' | 'image/jpeg' | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/**
 * AfyaPay staff governance: staff accounts, maker-checker approval requests
 * for roles and settings, launch gates with evidence, and the audit log.
 * Every rule here is also enforced by the database (migration 0011).
 */
@Injectable()
export class GovernanceService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // ---- staff -------------------------------------------------------------

  async listStaff() {
    const { rows } = await this.pool.query(
      `select u.id, u.email, u.display_name, u.status, u.totp_enrolled_at is not null as mfa_enrolled, u.created_at,
              array(select r from unnest(array['support', 'finance', 'compliance', 'super_admin']) r where governance.has_role(u.id, r)) as roles
         from governance.staff_user u order by u.created_at`,
    );
    return rows.map((r) => ({ id: r.id, email: r.email, displayName: r.display_name, status: r.status, mfaEnrolled: r.mfa_enrolled, roles: r.roles, createdAt: r.created_at }));
  }

  /** A new account has no roles; each role is a separate request a second super administrator approves. */
  async createStaff(actor: StaffUser, body: { email?: unknown; displayName?: unknown }) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const name = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 120) : '';
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) || name.length < 2) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'staff.invalid', 'Give a work email and a display name.');
    return this.tx(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'insert into governance.staff_user (email, display_name, created_by) values ($1, $2, $3) on conflict (email) do nothing returning id',
        [email, name, actor.id],
      );
      if (!rows[0]) throw fail(HttpStatus.CONFLICT, 'staff.exists', 'A staff account with this email already exists.');
      await this.audit(tx, actor, 'staff.created', 'staff_user', rows[0].id, { email });
      return { id: rows[0].id, email, displayName: name, roles: [] };
    });
  }

  // ---- accounts (staff and insurer users) --------------------------------

  async listInsurers() {
    const { rows } = await this.pool.query<{ code: string; name: string }>('select code, name from insurer.insurer order by name');
    return rows;
  }

  async listInsurerUsers() {
    const { rows } = await this.pool.query(
      `select u.id, u.email, u.display_name, u.role, u.status, u.totp_enrolled_at is not null as mfa_enrolled, u.created_at, i.name as insurer
         from insurer.insurer_user u join insurer.insurer i on i.id = u.insurer_id order by i.name, u.email`,
    );
    return rows.map((r) => ({ id: r.id, email: r.email, displayName: r.display_name, insurer: r.insurer, role: r.role, status: r.status, mfaEnrolled: r.mfa_enrolled, createdAt: r.created_at }));
  }

  /**
   * Suspends a staff or insurer account at once. It only takes access away,
   * so it needs no second approver; the guards read status on every request.
   */
  async suspend(actor: StaffUser, type: unknown, id: string, body: { reason?: unknown }) {
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 5 || reason.length > 500) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'approval.reason_required', 'Say why, in 5 to 500 characters.');
    if (!isAccountType(type) || !UUID.test(id)) throw fail(HttpStatus.NOT_FOUND, 'account.not_found', 'Account not found.');
    if (type === 'staff_user' && id === actor.id) throw fail(HttpStatus.FORBIDDEN, 'account.own', 'You cannot suspend your own account.');
    return this.tx(async (tx) => {
      const { rows } = await tx.query<{ status: string }>(`select status from ${ACCOUNT_TABLE[type]} where id = $1 for update`, [id]);
      if (!rows[0]) throw fail(HttpStatus.NOT_FOUND, 'account.not_found', 'Account not found.');
      if (rows[0].status === 'suspended') throw fail(HttpStatus.CONFLICT, 'account.no_change', 'This account is already suspended.');
      if (type === 'staff_user') {
        const admins = await tx.query<{ n: number; is_admin: boolean }>(
          "select (select count(*)::int from governance.staff_user u where governance.has_role(u.id, 'super_admin') and u.status = 'active') as n, governance.has_role($1, 'super_admin') as is_admin",
          [id],
        );
        if (admins.rows[0].is_admin && admins.rows[0].n <= 2) throw fail(HttpStatus.CONFLICT, 'approval.last_admins', 'At least two active super administrators must remain.');
      }
      await tx.query(`update ${ACCOUNT_TABLE[type]} set status = 'suspended' where id = $1`, [id]);
      await this.audit(tx, actor, 'account.suspended', type, id, { reason });
      return { id, type, status: 'suspended' };
    });
  }

  /** Resetting an authenticator or reactivating an account gives access back, so a super administrator approves it. */
  async proposeAccountAction(actor: StaffUser, type: unknown, id: string, body: { action?: unknown; reason?: unknown }) {
    if (!isAccountType(type) || !UUID.test(id)) throw fail(HttpStatus.NOT_FOUND, 'account.not_found', 'Account not found.');
    if (body.action !== 'reset_authenticator' && body.action !== 'reactivate') throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'approval.payload_invalid', 'action must be reset_authenticator or reactivate.');
    if (type === 'staff_user' && id === actor.id) throw fail(HttpStatus.FORBIDDEN, 'account.own', 'Ask someone else to request this for your account.');
    const { rows } = await this.pool.query<{ status: string; enrolled: boolean }>(`select status, totp_enrolled_at is not null as enrolled from ${ACCOUNT_TABLE[type]} where id = $1`, [id]);
    if (!rows[0]) throw fail(HttpStatus.NOT_FOUND, 'account.not_found', 'Account not found.');
    if (body.action === 'reactivate' && rows[0].status !== 'suspended') throw fail(HttpStatus.CONFLICT, 'approval.no_change', 'This account is not suspended.');
    if (body.action === 'reset_authenticator' && !rows[0].enrolled) throw fail(HttpStatus.CONFLICT, 'approval.no_change', 'This account has no authenticator set up yet.');
    return this.propose(actor, { kind: 'account_action', payload: { accountType: type, accountId: id, action: body.action }, reason: body.reason });
  }

  /**
   * Asks for a new insurer user. Adding one gives access, so a super
   * administrator approves it; the user is created on approval.
   */
  async proposeInsurerUser(actor: StaffUser, body: { insurerCode?: unknown; email?: unknown; displayName?: unknown; role?: unknown; reason?: unknown }) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'insurer_user.invalid', 'Enter their work email address.');
    // Before go-live only synthetic addresses can sign in, so only those can be added.
    if (!email.endsWith(`@${SYNTHETIC_STAFF_DOMAIN}`)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'email.synthetic_only', `Before go-live, only synthetic addresses (@${SYNTHETIC_STAFF_DOMAIN}) can be added.`);
    if (displayName.length < 2 || displayName.length > 120) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'insurer_user.invalid', 'Give their name, in 2 to 120 characters.');
    if (body.role !== 'viewer' && body.role !== 'operator' && body.role !== 'approver') throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'insurer_user.invalid', 'role must be viewer, operator or approver.');
    const insurer = (await this.pool.query<{ id: string; name: string }>('select id, name from insurer.insurer where code = $1', [typeof body.insurerCode === 'string' ? body.insurerCode : ''])).rows[0];
    if (!insurer) throw fail(HttpStatus.NOT_FOUND, 'insurer.not_found', 'Insurer not found.');
    const taken = await this.pool.query(
      "select 1 from insurer.insurer_user where email = $1 union all select 1 from governance.approval_request where kind = 'insurer_user_add' and status = 'proposed' and payload->>'email' = $1",
      [email],
    );
    if (taken.rowCount) throw fail(HttpStatus.CONFLICT, 'insurer_user.exists', 'This email already has an insurer account, or a request waiting.');
    return this.propose(actor, { kind: 'insurer_user_add', payload: { insurerId: insurer.id, insurerName: insurer.name, email, displayName, role: body.role }, reason: body.reason });
  }

  // ---- approval requests -------------------------------------------------

  async propose(actor: StaffUser, body: { kind?: unknown; payload?: unknown; reason?: unknown }) {
    const kind = body.kind as Kind;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 5 || reason.length > 500) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'approval.reason_required', 'Say why, in 5 to 500 characters.');
    const p = (body.payload ?? {}) as Record<string, unknown>;
    let payload: Record<string, unknown>;
    if (kind === 'role_grant' || kind === 'role_revoke') {
      if (typeof p.staffUserId !== 'string' || !UUID.test(p.staffUserId) || !STAFF_ROLES.includes(p.role as StaffRole)) {
        throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'approval.payload_invalid', `Give staffUserId and a role: ${STAFF_ROLES.join(', ')}.`);
      }
      const { rows } = await this.pool.query<{ has: boolean }>('select governance.has_role(id, $2) as has from governance.staff_user where id = $1', [p.staffUserId, p.role]);
      if (!rows[0]) throw fail(HttpStatus.NOT_FOUND, 'staff.not_found', 'Staff account not found.');
      if (rows[0].has === (kind === 'role_grant')) throw fail(HttpStatus.CONFLICT, 'approval.no_change', kind === 'role_grant' ? 'This person already has that role.' : 'This person does not have that role.');
      payload = { staffUserId: p.staffUserId, role: p.role };
    } else if (kind === 'setting_change') {
      payload = { key: p.key, value: await this.checkSetting(p.key, p.value) };
    } else if (kind === 'account_action') {
      if (!isAccountType(p.accountType) || typeof p.accountId !== 'string' || !UUID.test(p.accountId) || (p.action !== 'reset_authenticator' && p.action !== 'reactivate')) {
        throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'approval.payload_invalid', 'Request account actions from the Accounts page.');
      }
      payload = { accountType: p.accountType, accountId: p.accountId, action: p.action };
    } else if (kind === 'insurer_user_add') {
      if (typeof p.insurerId !== 'string' || !UUID.test(p.insurerId) || typeof p.email !== 'string' || typeof p.displayName !== 'string' || !['viewer', 'operator', 'approver'].includes(p.role as string)) {
        throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'approval.payload_invalid', 'Add insurer users from the Insurer users page.');
      }
      if (!p.email.endsWith(`@${SYNTHETIC_STAFF_DOMAIN}`)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'email.synthetic_only', `Before go-live, only synthetic addresses (@${SYNTHETIC_STAFF_DOMAIN}) can be added.`);
      payload = { insurerId: p.insurerId, insurerName: typeof p.insurerName === 'string' ? p.insurerName.slice(0, 120) : undefined, email: p.email, displayName: p.displayName, role: p.role };
    } else if (kind === 'customer_unmask') {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'approval.kind_invalid', 'Ask to see a full phone number from the customer lookup.');
    } else {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'approval.kind_invalid', 'kind must be role_grant, role_revoke, setting_change, account_action or insurer_user_add.');
    }
    return this.tx(async (tx) => {
      const { rows } = await tx.query<{ id: string }>('insert into governance.approval_request (kind, payload, reason, proposed_by) values ($1, $2, $3, $4) returning id', [kind, payload, reason, actor.id]);
      await this.audit(tx, actor, 'approval.proposed', 'approval_request', rows[0].id, { kind, payload });
      return this.viewRequest(tx, rows[0].id);
    });
  }

  async listRequests(status?: string) {
    const filter = status && ['proposed', 'approved', 'rejected', 'withdrawn'].includes(status) ? status : null;
    const { rows } = await this.pool.query<{ id: string }>('select id from governance.approval_request where $1::text is null or status = $1 order by created_at desc limit 200', [filter]);
    const out = [];
    for (const r of rows) out.push(await this.viewRequest(this.pool, r.id));
    return out;
  }

  /** A second super administrator approves; the change applies in the same transaction. */
  async approve(actor: StaffUser, id: string, body: { note?: unknown }) {
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
    return this.decide(actor, id, async (tx, req) => {
      await guarded(() => tx.query("update governance.approval_request set status = 'approved', decided_by = $2, decision_note = $3, decided_at = now() where id = $1", [id, actor.id, note]));
      if (req.kind === 'customer_unmask') {
        // Nothing to apply: the approval lets the proposer see the number for 30 minutes.
      } else if (req.kind === 'account_action') {
        const table = ACCOUNT_TABLE[req.payload.accountType as AccountType];
        const sql =
          req.payload.action === 'reactivate'
            ? `update ${table} set status = 'active' where id = $1 and status = 'suspended'`
            : `update ${table} set totp_secret_enc = null, totp_enrolled_at = null, last_totp_step = null where id = $1`;
        const done = await tx.query(sql, [req.payload.accountId]);
        if (!done.rowCount) throw fail(HttpStatus.CONFLICT, 'approval.no_change', 'Nothing to change: the account is already in that state.');
      } else if (req.kind === 'insurer_user_add') {
        const p = req.payload;
        const added = await tx.query<{ id: string }>(
          'insert into insurer.insurer_user (insurer_id, email, display_name, role) values ($1, $2, $3, $4) on conflict (email) do nothing returning id',
          [p.insurerId, p.email, p.displayName, p.role],
        );
        if (!added.rows[0]) throw fail(HttpStatus.CONFLICT, 'approval.no_change', 'Nothing to change: this email already has an insurer account.');
        await this.audit(tx, actor, 'insurer_user.created', 'insurer_user', added.rows[0].id, { insurerId: p.insurerId, email: p.email, role: p.role, approvalRequestId: id });
      } else if (req.kind === 'setting_change') {
        if (req.payload.key === 'live_money_enabled' && req.payload.value === true) await this.checkLiveMoneyGates(tx);
        if (req.payload.key === 'plan_buying_enabled' && req.payload.value === true) await this.checkBuyingGate(tx);
        await guarded(() => tx.query('insert into governance.setting_event (key, value, approval_request_id) values ($1, $2, $3)', [req.payload.key, JSON.stringify(req.payload.value), id]));
      } else {
        if (req.kind === 'role_revoke' && req.payload.role === 'super_admin') {
          const { rows } = await tx.query<{ n: number }>("select count(*)::int as n from governance.staff_user u where governance.has_role(u.id, 'super_admin') and u.status = 'active'");
          if (rows[0].n <= 2) throw fail(HttpStatus.CONFLICT, 'approval.last_admins', 'At least two active super administrators must remain.');
        }
        await guarded(() =>
          tx.query('insert into governance.staff_role_event (staff_user_id, role, action, approval_request_id) values ($1, $2, $3, $4)', [req.payload.staffUserId, req.payload.role, req.kind === 'role_grant' ? 'grant' : 'revoke', id]),
        );
      }
      await this.audit(tx, actor, 'approval.approved', 'approval_request', id, { kind: req.kind, payload: req.payload });
    });
  }

  async reject(actor: StaffUser, id: string, body: { note?: unknown }) {
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    if (note.length < 5) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'approval.note_required', 'Say why the request is rejected.');
    return this.decide(actor, id, async (tx) => {
      await guarded(() => tx.query("update governance.approval_request set status = 'rejected', decided_by = $2, decision_note = $3, decided_at = now() where id = $1", [id, actor.id, note]));
      await this.audit(tx, actor, 'approval.rejected', 'approval_request', id, { note });
    });
  }

  async withdraw(actor: StaffUser, id: string) {
    if (!UUID.test(id)) throw fail(HttpStatus.NOT_FOUND, 'approval.not_found', 'Request not found.');
    return this.tx(async (tx) => {
      const { rows } = await tx.query<{ status: string; proposed_by: string }>('select status, proposed_by from governance.approval_request where id = $1 for update', [id]);
      if (!rows[0]) throw fail(HttpStatus.NOT_FOUND, 'approval.not_found', 'Request not found.');
      if (rows[0].proposed_by !== actor.id) throw fail(HttpStatus.FORBIDDEN, 'approval.not_proposer', 'Only the person who proposed a request can withdraw it.');
      if (rows[0].status !== 'proposed') throw fail(HttpStatus.CONFLICT, 'approval.already_decided', `This request is already ${rows[0].status}.`);
      await tx.query("update governance.approval_request set status = 'withdrawn', decided_at = now() where id = $1", [id]);
      await this.audit(tx, actor, 'approval.withdrawn', 'approval_request', id, null);
      return this.viewRequest(tx, id);
    });
  }

  private async decide(actor: StaffUser, id: string, fn: (tx: PoolClient, req: { kind: Kind; payload: Record<string, unknown> }) => Promise<void>) {
    if (!UUID.test(id)) throw fail(HttpStatus.NOT_FOUND, 'approval.not_found', 'Request not found.');
    return this.tx(async (tx) => {
      const { rows } = await tx.query<{ status: string; proposed_by: string; kind: Kind; payload: Record<string, unknown> }>('select status, proposed_by, kind, payload from governance.approval_request where id = $1 for update', [id]);
      const req = rows[0];
      if (!req) throw fail(HttpStatus.NOT_FOUND, 'approval.not_found', 'Request not found.');
      if (req.status !== 'proposed') throw fail(HttpStatus.CONFLICT, 'approval.already_decided', `This request is already ${req.status}.`);
      if (req.proposed_by === actor.id) throw fail(HttpStatus.FORBIDDEN, 'approval.second_person', 'Someone other than the proposer must decide this request.');
      const deciders = req.kind === 'customer_unmask' ? ['compliance', 'super_admin'] : ['super_admin'];
      if (!actor.roles.some((r) => deciders.includes(r))) throw fail(HttpStatus.FORBIDDEN, 'staff.role_required', `Only ${deciders.join(' or ')} can decide this request.`);
      if ((req.kind === 'role_grant' || req.kind === 'role_revoke') && req.payload.staffUserId === actor.id) throw fail(HttpStatus.FORBIDDEN, 'approval.own_roles', 'Nobody can decide a change to their own roles.');
      if (req.kind === 'account_action' && req.payload.accountId === actor.id) throw fail(HttpStatus.FORBIDDEN, 'approval.own_account', 'Nobody can decide an action on their own account.');
      await fn(tx, req);
      return this.viewRequest(tx, id);
    });
  }

  private async viewRequest(db: Pool | PoolClient, id: string) {
    const { rows } = await db.query(
      `select r.id, r.kind, r.payload, r.reason, r.status, r.decision_note, r.created_at, r.decided_at,
              r.proposed_by, p.email as proposed_by_email, r.decided_by, d.email as decided_by_email
         from governance.approval_request r
         join governance.staff_user p on p.id = r.proposed_by
         left join governance.staff_user d on d.id = r.decided_by
        where r.id = $1`,
      [id],
    );
    const r = rows[0];
    return {
      id: r.id, kind: r.kind, payload: r.payload, reason: r.reason, status: r.status, decisionNote: r.decision_note,
      proposedBy: { id: r.proposed_by, email: r.proposed_by_email }, decidedBy: r.decided_by ? { id: r.decided_by, email: r.decided_by_email } : null,
      createdAt: r.created_at, decidedAt: r.decided_at,
    };
  }

  // ---- settings ----------------------------------------------------------

  private async checkSetting(key: unknown, value: unknown): Promise<unknown> {
    if (key === 'live_money_enabled') {
      if (typeof value !== 'boolean') throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'setting.invalid', 'live_money_enabled is true or false.');
      if (value) await this.checkLiveMoneyGates(this.pool);
      return value;
    }
    if (key === 'plan_buying_enabled') {
      if (typeof value !== 'boolean') throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'setting.invalid', 'plan_buying_enabled is true or false.');
      if (value) await this.checkBuyingGate(this.pool);
      return value;
    }
    if (key === 'staff_ip_allowlist') {
      if (!Array.isArray(value) || value.length > 50 || !value.every((v) => typeof v === 'string' && /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(v))) {
        throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'setting.invalid', 'staff_ip_allowlist is a list of up to 50 addresses or ranges, such as "196.201.214.0/24".');
      }
      try {
        const { rows } = await this.pool.query<{ v: string[] }>('select array(select c::cidr::text from unnest($1::text[]) c) as v', [value]);
        return rows[0].v;
      } catch {
        throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'setting.invalid', 'One of the addresses or ranges is not valid.');
      }
    }
    throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'setting.unknown', 'key must be staff_ip_allowlist, live_money_enabled or plan_buying_enabled.');
  }

  private async checkLiveMoneyGates(db: Pool | PoolClient) {
    const { rows } = await db.query<{ code: string }>('select code from unnest($1::text[]) as t(code) where not governance.gate_closed(code) order by 1', [PILOT_GATES_FOR_LIVE_MONEY]);
    if (rows.length) throw fail(HttpStatus.CONFLICT, 'live_money.gates_open', `Live money stays off until launch gates G1 to G5 are closed. Still open: ${rows.map((r) => r.code).join(', ')}.`);
  }

  private async checkBuyingGate(db: Pool | PoolClient) {
    const { rows } = await db.query<{ closed: boolean }>("select governance.gate_closed('G6') as closed");
    if (!rows[0].closed) throw fail(HttpStatus.CONFLICT, 'plan_buying.gate_open', 'Buying plans stays off until launch gate G6 (distribution licence route) is closed.');
  }

  async settings() {
    const { rows } = await this.pool.query<{ ip: string[] | null; live: boolean | null; allowed: boolean; buying: boolean | null; buying_allowed: boolean }>(
      `select governance.setting('staff_ip_allowlist') as ip, governance.setting('live_money_enabled') as live, governance.live_money_allowed() as allowed,
              governance.setting('plan_buying_enabled') as buying, governance.plan_buying_allowed() as buying_allowed`,
    );
    const open = (await this.pool.query<{ code: string }>('select code from unnest($1::text[]) as t(code) where not governance.gate_closed(code) order by 1', [PILOT_GATES_FOR_LIVE_MONEY])).rows.map((r) => r.code);
    return {
      staffIpAllowlist: rows[0].ip ?? [],
      liveMoney: { switchedOn: rows[0].live ?? false, allowed: rows[0].allowed, gatesStillOpen: open },
      planBuying: { switchedOn: rows[0].buying ?? false, allowed: rows[0].buying_allowed },
    };
  }

  // ---- launch gates ------------------------------------------------------

  async gates() {
    const { rows } = await this.pool.query(
      `select g.code, g.title, g.needed_for, governance.gate_closed(g.code) as closed,
              (select count(*)::int from governance.gate_evidence e where e.gate_code = g.code) as evidence_count,
              (select json_build_object('status', ev.status, 'note', ev.note, 'by', u.email, 'at', ev.created_at)
                 from governance.gate_event ev join governance.staff_user u on u.id = ev.actor_id
                where ev.gate_code = g.code order by ev.seq desc limit 1) as last_change
         from governance.launch_gate g order by g.code`,
    );
    return rows.map((r) => ({ code: r.code, title: r.title, neededFor: r.needed_for, status: r.closed ? 'closed' : 'open', evidenceCount: r.evidence_count, lastChange: r.last_change }));
  }

  async gate(code: string) {
    const g = (await this.gates()).find((x) => x.code === code);
    if (!g) throw fail(HttpStatus.NOT_FOUND, 'gate.not_found', 'Launch gate not found.');
    const ev = await this.pool.query(
      `select e.id, e.title, e.file_name, e.content_type, octet_length(e.content) as bytes, u.email as uploaded_by, e.created_at
         from governance.gate_evidence e join governance.staff_user u on u.id = e.uploaded_by where e.gate_code = $1 order by e.created_at`,
      [code],
    );
    const hist = await this.pool.query(
      'select ev.status, ev.note, u.email as by, ev.created_at as at from governance.gate_event ev join governance.staff_user u on u.id = ev.actor_id where ev.gate_code = $1 order by ev.seq',
      [code],
    );
    return {
      ...g,
      evidence: ev.rows.map((r) => ({ id: r.id, title: r.title, fileName: r.file_name, contentType: r.content_type, bytes: r.bytes, uploadedBy: r.uploaded_by, uploadedAt: r.created_at })),
      history: hist.rows,
    };
  }

  /** Evidence is a title with an optional PDF, PNG or JPEG. It is kept for good; it never changes or goes away. */
  async addEvidence(actor: StaffUser, code: string, body: { title?: unknown }, file: UploadedEvidence | undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title.length < 3 || title.length > 200) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'evidence.title_required', 'Give the evidence a title of 3 to 200 characters.');
    let type: string | null = null;
    if (file?.buffer?.length) {
      if (file.buffer.length > MAX_EVIDENCE_BYTES) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'evidence.too_large', 'Evidence files can be up to 10 MB.');
      type = evidenceType(file.buffer);
      if (!type) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'evidence.type', 'Evidence files must be PDF, PNG or JPEG.');
    }
    return this.tx(async (tx) => {
      const exists = await tx.query('select 1 from governance.launch_gate where code = $1', [code]);
      if (!exists.rowCount) throw fail(HttpStatus.NOT_FOUND, 'gate.not_found', 'Launch gate not found.');
      const { rows } = await tx.query<{ id: string; created_at: Date }>(
        'insert into governance.gate_evidence (gate_code, title, file_name, content_type, content, uploaded_by) values ($1, $2, $3, $4, $5, $6) returning id, created_at',
        [code, title, type ? (file!.originalname || 'evidence').slice(0, 200) : null, type, type ? file!.buffer : null, actor.id],
      );
      await this.audit(tx, actor, 'gate.evidence_added', 'launch_gate', code, { evidenceId: rows[0].id, title });
      return { id: rows[0].id, gate: code, title, contentType: type, uploadedAt: rows[0].created_at };
    });
  }

  async evidenceContent(code: string, id: string): Promise<{ fileName: string; contentType: string; content: Buffer }> {
    if (!UUID.test(id)) throw fail(HttpStatus.NOT_FOUND, 'evidence.not_found', 'Evidence not found.');
    const { rows } = await this.pool.query('select file_name, content_type, content from governance.gate_evidence where id = $1 and gate_code = $2 and content is not null', [id, code]);
    if (!rows[0]) throw fail(HttpStatus.NOT_FOUND, 'evidence.not_found', 'Evidence not found.');
    return { fileName: rows[0].file_name, contentType: rows[0].content_type, content: rows[0].content };
  }

  /** Only compliance closes or reopens a gate; closing needs evidence. The database refuses anything else. */
  async setGate(actor: StaffUser, code: string, status: 'closed' | 'reopened', body: { note?: unknown }) {
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length < 5 || note.length > 1000) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'gate.note_required', 'Say what the evidence shows, in 5 to 1,000 characters.');
    return this.tx(async (tx) => {
      const { rows } = await tx.query<{ closed: boolean; evidence: number }>(
        'select governance.gate_closed(code) as closed, (select count(*)::int from governance.gate_evidence e where e.gate_code = g.code) as evidence from governance.launch_gate g where code = $1',
        [code],
      );
      if (!rows[0]) throw fail(HttpStatus.NOT_FOUND, 'gate.not_found', 'Launch gate not found.');
      if (rows[0].closed === (status === 'closed')) throw fail(HttpStatus.CONFLICT, 'gate.no_change', `Launch gate ${code} is already ${rows[0].closed ? 'closed' : 'open'}.`);
      if (status === 'closed' && rows[0].evidence === 0) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'gate.evidence_required', `Add evidence to ${code} before closing it.`);
      await guarded(() => tx.query('insert into governance.gate_event (gate_code, status, note, actor_id) values ($1, $2, $3, $4)', [code, status, note, actor.id]));
      await this.audit(tx, actor, status === 'closed' ? 'gate.closed' : 'gate.reopened', 'launch_gate', code, { note });
      return { code, status: status === 'closed' ? 'closed' : 'open' };
    });
  }

  // ---- audit log ---------------------------------------------------------

  async auditLog(query: Record<string, unknown>) {
    const s = (k: string) => (typeof query[k] === 'string' && (query[k] as string).length <= 200 ? (query[k] as string) : null);
    const before = s('beforeSeq') && /^\d+$/.test(s('beforeSeq')!) ? s('beforeSeq') : null;
    const limit = Math.min(Math.max(Number(s('limit') ?? 100) || 100, 1), 500);
    const { rows } = await this.pool.query(
      `select seq, occurred_at, actor_type, actor_id, action, subject_type, subject_id, before_state, after_state, hash
         from governance.audit_event
        where ($1::text is null or actor_type = $1) and ($2::text is null or actor_id = $2) and ($3::text is null or action like $3 || '%')
          and ($4::text is null or subject_type = $4) and ($5::text is null or subject_id = $5) and ($6::bigint is null or seq < $6)
        order by seq desc limit $7`,
      [s('actorType'), s('actorId'), s('action'), s('subjectType'), s('subjectId'), before, limit],
    );
    return {
      events: rows.map((r) => ({ seq: Number(r.seq), occurredAt: r.occurred_at, actorType: r.actor_type, actorId: r.actor_id, action: r.action, subjectType: r.subject_type, subjectId: r.subject_id, before: r.before_state, after: r.after_state, hash: r.hash })),
      nextBeforeSeq: rows.length === limit ? Number(rows[rows.length - 1].seq) : null,
    };
  }

  async verifyAudit(actor: StaffUser) {
    const { rows } = await this.pool.query('select * from governance.verify_audit_chain()');
    const r = rows[0];
    const result = { intact: r.problem === null, checked: Number(r.checked), total: Number(r.total), headHash: r.head_hash, firstBadSeq: r.first_bad_seq === null ? null : Number(r.first_bad_seq), problem: r.problem };
    await this.tx((tx) => this.audit(tx, actor, 'audit.verified', 'audit_chain', 'governance.audit_event', { intact: result.intact, checked: result.checked }));
    return result;
  }

  // ---- helpers -----------------------------------------------------------

  private async audit(tx: PoolClient, actor: StaffUser, action: string, subjectType: string, subjectId: string, after: unknown) {
    await tx.query(
      "insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id, after_state) values ('staff_user', $1, $2, $3, $4, $5)",
      [actor.id, action, subjectType, subjectId, after === null ? null : JSON.stringify(after)],
    );
  }

  private async tx<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try {
      await tx.query('begin');
      const result = await fn(tx);
      await tx.query('commit');
      return result;
    } catch (err) {
      await tx.query('rollback');
      throw err;
    } finally {
      tx.release();
    }
  }
}
