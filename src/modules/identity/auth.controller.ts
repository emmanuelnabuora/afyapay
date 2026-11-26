import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { SkipIdempotency } from '../platform/idempotency.interceptor';
import { AuthService } from './auth.service';
import { CustomerAuthGuard, CustomerRequest } from './customer-auth.guard';
import { maskPhone } from './phone';

/**
 * Sign-in endpoints skip the Idempotency-Key store on purpose: replaying a
 * stored response would mean keeping access and refresh tokens in the
 * database in clear. They are safe to retry without it: a repeated code
 * request is rate-limited, and a code or refresh token works only once.
 */
@Controller('auth')
@SkipIdempotency()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('otp')
  @HttpCode(202)
  requestOtp(@Body() body: { phone?: unknown }) {
    return this.auth.requestOtp(body?.phone);
  }

  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() body: { challengeId?: unknown; code?: unknown }) {
    return this.auth.verifyOtp(body?.challengeId, body?.code);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: { refreshToken?: unknown }) {
    return this.auth.refresh(body?.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: { refreshToken?: unknown }) {
    await this.auth.logout(body?.refreshToken);
  }
}

@Controller('me')
@UseGuards(CustomerAuthGuard)
export class MeController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  async me(@Req() req: CustomerRequest) {
    const { rows } = await this.pool.query<{ id: string; phone_e164: string; created_at: Date }>(
      "select id, phone_e164, created_at from identity.customer where id = $1 and status = 'active'",
      [req.customer!.sub],
    );
    if (!rows[0]) throw new NotFoundException({ code: 'customer.not_found', message: 'Account not found.' });
    return { id: rows[0].id, phone: maskPhone(rows[0].phone_e164), memberSince: rows[0].created_at };
  }
}
