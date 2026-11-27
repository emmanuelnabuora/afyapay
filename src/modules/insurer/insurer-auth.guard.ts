import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { InsurerClaims, InsurerRole, verifyInsurerToken } from './insurer-auth.service';

export type InsurerRequest = Request & { insurerUser?: InsurerClaims; user?: { id: string } };

const ROLES = 'insurer_roles';
/** Roles allowed on a route. Approvers can do everything operators can. */
export const InsurerRoles = (...roles: InsurerRole[]) => SetMetadata(ROLES, roles);

@Injectable()
export class InsurerAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<InsurerRequest>();
    const header = req.header('authorization') ?? '';
    const claims = header.startsWith('Bearer ') ? verifyInsurerToken(header.slice(7)) : null;
    if (!claims) throw new UnauthorizedException({ code: 'auth.required', message: 'Sign in to the insurer portal.' });
    const allowed = this.reflector.getAllAndOverride<InsurerRole[] | undefined>(ROLES, [context.getHandler(), context.getClass()]);
    if (allowed && !allowed.includes(claims.role)) throw new ForbiddenException({ code: 'staff.role_required', message: `This needs one of these roles: ${allowed.join(', ')}.` });
    req.insurerUser = claims;
    req.user = { id: `insurer_user:${claims.sub}` }; // idempotency scope
    return true;
  }
}
