import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { clientIp, StaffRole, staffIpAllowed, verifyStaffToken } from './staff-auth.service';

export interface StaffUser {
  id: string;
  email: string;
  roles: StaffRole[];
  ip: string;
}
export type StaffRequest = Request & { staffUser?: StaffUser; user?: { id: string } };

const ROLES = 'staff_roles';
/** Roles allowed on a route: any one of them is enough. */
export const StaffRoles = (...roles: StaffRole[]) => SetMetadata(ROLES, roles);

/**
 * Checks the staff token, then on every request reads the user's status and
 * current roles from the database and checks the IP allow-list, so a revoked
 * role, a suspended account or a new allow-list applies at once.
 */
@Injectable()
export class StaffAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<StaffRequest>();
    const header = req.header('authorization') ?? '';
    const claims = header.startsWith('Bearer ') ? verifyStaffToken(header.slice(7)) : null;
    if (!claims) throw new UnauthorizedException({ code: 'auth.required', message: 'Sign in to AfyaPay admin.' });
    const ip = clientIp(req.ip);
    if (!(await staffIpAllowed(this.pool, ip))) throw new ForbiddenException({ code: 'staff.ip_not_allowed', message: 'Staff access is not allowed from this network.' });
    const { rows } = await this.pool.query<{ email: string; status: string; roles: StaffRole[] }>(
      `select u.email, u.status, array(select r from unnest(array['support', 'finance', 'compliance', 'super_admin']) r where governance.has_role(u.id, r)) as roles
         from governance.staff_user u where u.id = $1`,
      [claims.sub],
    );
    const u = rows[0];
    if (!u || u.status !== 'active') throw new UnauthorizedException({ code: 'auth.required', message: 'Sign in to AfyaPay admin.' });
    const allowed = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES, [context.getHandler(), context.getClass()]);
    if (allowed && !allowed.some((r) => u.roles.includes(r))) {
      throw new ForbiddenException({ code: 'staff.role_required', message: `This needs one of these roles: ${allowed.join(', ')}.` });
    }
    req.staffUser = { id: claims.sub, email: u.email, roles: u.roles, ip };
    req.user = { id: `staff_user:${claims.sub}` }; // idempotency scope
    return true;
  }
}
