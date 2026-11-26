import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AccessClaims, verifyAccessToken } from './tokens';

export type CustomerRequest = Request & { customer?: AccessClaims; user?: { id: string } };

/**
 * Accepts a valid customer access token (15 minutes). Tokens are stateless, so
 * sign-out takes effect when the access token expires; refresh stops at once.
 */
@Injectable()
export class CustomerAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<CustomerRequest>();
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const claims = token ? verifyAccessToken(token) : null;
    if (!claims) throw new UnauthorizedException({ code: 'auth.required', message: 'Sign in to continue.' });
    req.customer = claims;
    req.user = { id: claims.sub }; // used by the idempotency scope
    return true;
  }
}
