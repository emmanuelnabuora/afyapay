import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipIdempotency } from '../platform/idempotency.interceptor';
import { GovernanceService, UploadedEvidence } from './governance.service';
import { StaffAuthGuard, StaffRequest, StaffRoles } from './staff-auth.guard';
import { clientIp, StaffAuthService } from './staff-auth.service';

/**
 * AfyaPay staff sign-in. Skips the Idempotency-Key store so tokens are never
 * kept in clear; codes and tickets work once and are rate-limited.
 */
@Controller('admin-auth')
@SkipIdempotency()
export class StaffAuthController {
  constructor(private readonly auth: StaffAuthService) {}

  @Post('email-code')
  @HttpCode(202)
  emailCode(@Req() req: StaffRequest, @Body() body: { email?: unknown }) {
    return this.auth.requestEmailCode(body?.email, clientIp(req.ip));
  }

  @Post('email-code/verify')
  @HttpCode(200)
  verifyEmail(@Req() req: StaffRequest, @Body() body: { challengeId?: unknown; code?: unknown }) {
    return this.auth.verifyEmailCode(body?.challengeId, body?.code, clientIp(req.ip));
  }

  @Post('mfa/enrol')
  @HttpCode(200)
  enrol(@Req() req: StaffRequest, @Body() body: { mfaTicket?: unknown }) {
    return this.auth.startEnrolment(body?.mfaTicket, clientIp(req.ip));
  }

  @Post('mfa/verify')
  @HttpCode(200)
  verifyMfa(@Req() req: StaffRequest, @Body() body: { mfaTicket?: unknown; code?: unknown }) {
    return this.auth.verifyAuthenticator(body?.mfaTicket, body?.code, clientIp(req.ip));
  }
}

@Controller('admin')
@UseGuards(StaffAuthGuard)
export class GovernanceController {
  constructor(private readonly gov: GovernanceService) {}

  @Get('me')
  me(@Req() req: StaffRequest) {
    const u = req.staffUser!;
    return { id: u.id, email: u.email, roles: u.roles };
  }

  @Get('staff')
  @StaffRoles('super_admin', 'compliance')
  staff() {
    return this.gov.listStaff();
  }

  @Post('staff')
  @StaffRoles('super_admin')
  createStaff(@Req() req: StaffRequest, @Body() body: Record<string, unknown>) {
    return this.gov.createStaff(req.staffUser!, body ?? {});
  }

  /** Role grants, role removals and setting changes. A different super administrator decides. */
  @Post('approvals')
  @StaffRoles('super_admin')
  propose(@Req() req: StaffRequest, @Body() body: Record<string, unknown>) {
    return this.gov.propose(req.staffUser!, body ?? {});
  }

  @Get('approvals')
  @StaffRoles('super_admin', 'compliance')
  approvals(@Query('status') status?: string) {
    return this.gov.listRequests(status);
  }

  @Post('approvals/:id/approve')
  @StaffRoles('super_admin')
  @HttpCode(200)
  approve(@Req() req: StaffRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.gov.approve(req.staffUser!, id, body ?? {});
  }

  @Post('approvals/:id/reject')
  @StaffRoles('super_admin')
  @HttpCode(200)
  reject(@Req() req: StaffRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.gov.reject(req.staffUser!, id, body ?? {});
  }

  @Post('approvals/:id/withdraw')
  @HttpCode(200)
  withdraw(@Req() req: StaffRequest, @Param('id') id: string) {
    return this.gov.withdraw(req.staffUser!, id);
  }

  @Get('settings')
  settings() {
    return this.gov.settings();
  }

  @Get('launch-gates')
  gates() {
    return this.gov.gates();
  }

  @Get('launch-gates/:code')
  gate(@Param('code') code: string) {
    return this.gov.gate(code);
  }

  /** Multipart: field "title", optional field "file" (PDF, PNG or JPEG up to 10 MB). Needs an Idempotency-Key. */
  @Post('launch-gates/:code/evidence')
  @StaffRoles('compliance', 'super_admin')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  addEvidence(@Req() req: StaffRequest, @Param('code') code: string, @Body() body: Record<string, unknown>, @UploadedFile() file: UploadedEvidence | undefined) {
    return this.gov.addEvidence(req.staffUser!, code, body ?? {}, file);
  }

  @Get('launch-gates/:code/evidence/:id/content')
  async evidence(@Param('code') code: string, @Param('id') id: string) {
    const e = await this.gov.evidenceContent(code, id);
    return new StreamableFile(e.content, { type: e.contentType, disposition: `attachment; filename="${e.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"` });
  }

  @Post('launch-gates/:code/close')
  @StaffRoles('compliance')
  @HttpCode(200)
  close(@Req() req: StaffRequest, @Param('code') code: string, @Body() body: Record<string, unknown>) {
    return this.gov.setGate(req.staffUser!, code, 'closed', body ?? {});
  }

  @Post('launch-gates/:code/reopen')
  @StaffRoles('compliance')
  @HttpCode(200)
  reopen(@Req() req: StaffRequest, @Param('code') code: string, @Body() body: Record<string, unknown>) {
    return this.gov.setGate(req.staffUser!, code, 'reopened', body ?? {});
  }

  @Get('audit-events')
  @StaffRoles('compliance', 'super_admin')
  audit(@Query() query: Record<string, unknown>) {
    return this.gov.auditLog(query);
  }

  @Post('audit-events/verify')
  @StaffRoles('compliance', 'super_admin')
  @HttpCode(200)
  verify(@Req() req: StaffRequest) {
    return this.gov.verifyAudit(req.staffUser!);
  }
}
