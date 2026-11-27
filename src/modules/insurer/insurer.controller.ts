import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { UploadedFile as UploadedRows } from '../reconciliation/file-rows';
import { CoverBatchService } from './cover-batch.service';
import { SkipIdempotency } from '../platform/idempotency.interceptor';
import { InsurerAuthGuard, InsurerRequest, InsurerRoles } from './insurer-auth.guard';
import { InsurerAuthService } from './insurer-auth.service';
import { InsurerPortalService } from './insurer-portal.service';

/**
 * Insurer staff sign-in. Skips the Idempotency-Key store so tokens are never
 * kept in clear; codes and tickets work once and are rate-limited.
 */
@Controller('insurer-auth')
@SkipIdempotency()
export class InsurerAuthController {
  constructor(private readonly auth: InsurerAuthService) {}

  @Post('email-code')
  @HttpCode(202)
  emailCode(@Body() body: { email?: unknown }) {
    return this.auth.requestEmailCode(body?.email);
  }

  @Post('email-code/verify')
  @HttpCode(200)
  verifyEmail(@Body() body: { challengeId?: unknown; code?: unknown }) {
    return this.auth.verifyEmailCode(body?.challengeId, body?.code);
  }

  @Post('mfa/enrol')
  @HttpCode(200)
  enrol(@Body() body: { mfaTicket?: unknown }) {
    return this.auth.startEnrolment(body?.mfaTicket);
  }

  @Post('mfa/verify')
  @HttpCode(200)
  verifyMfa(@Body() body: { mfaTicket?: unknown; code?: unknown }) {
    return this.auth.verifyAuthenticator(body?.mfaTicket, body?.code);
  }
}

@Controller('insurer')
@UseGuards(InsurerAuthGuard)
export class InsurerPortalController {
  constructor(private readonly portal: InsurerPortalService) {}

  @Get('me')
  me(@Req() req: InsurerRequest) {
    const u = req.insurerUser!;
    return { userId: u.sub, insurerId: u.ins, role: u.role };
  }

  @Get('policy-links')
  links(@Req() req: InsurerRequest, @Query('status') status?: string) {
    return this.portal.listLinks(req.insurerUser!, status);
  }

  @Post('policy-links/:id/decision')
  @InsurerRoles('operator', 'approver')
  @HttpCode(200)
  decide(@Req() req: InsurerRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.portal.decideLink(req.insurerUser!, id, body ?? {});
  }

  @Post('policy-links/:id/premium-schedule')
  @InsurerRoles('operator', 'approver')
  schedule(@Req() req: InsurerRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.portal.setPremiumSchedule(req.insurerUser!, id, body ?? {});
  }

  @Post('policy-links/:id/cover-events')
  @InsurerRoles('operator', 'approver')
  cover(@Req() req: InsurerRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.portal.recordCover(req.insurerUser!, id, body ?? {});
  }

  @Get('payments')
  payments(@Req() req: InsurerRequest, @Query() query: Record<string, unknown>) {
    return this.portal.listPayments(req.insurerUser!, query);
  }
}

/**
 * Bulk cover changes from an insurer file (CSV or Excel). Up to 50 lines
 * apply at once; larger batches wait for a different person with the
 * approver role. The database refuses an approval by the proposer.
 */
@Controller('insurer/cover-batches')
@UseGuards(InsurerAuthGuard)
export class CoverBatchController {
  constructor(private readonly batches: CoverBatchService) {}

  /** Multipart upload, field "file", CSV or .xlsx up to 5 MB. Needs an Idempotency-Key. */
  @Post()
  @InsurerRoles('operator', 'approver')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  propose(@Req() req: InsurerRequest, @UploadedFile() file: UploadedRows | undefined) {
    return this.batches.propose(req.insurerUser!, file);
  }

  @Get()
  list(@Req() req: InsurerRequest) {
    return this.batches.list(req.insurerUser!);
  }

  @Get(':id')
  get(@Req() req: InsurerRequest, @Param('id') id: string) {
    return this.batches.get(req.insurerUser!, id);
  }

  @Post(':id/approve')
  @InsurerRoles('approver')
  @HttpCode(200)
  approve(@Req() req: InsurerRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.batches.approve(req.insurerUser!, id, body ?? {});
  }

  @Post(':id/reject')
  @InsurerRoles('approver')
  @HttpCode(200)
  reject(@Req() req: InsurerRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.batches.reject(req.insurerUser!, id, body ?? {});
  }
}
