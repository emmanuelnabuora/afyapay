import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InsurerAuthGuard, InsurerRequest, InsurerRoles } from '../insurer/insurer-auth.guard';
import { ReconciliationService } from './reconciliation.service';

import type { UploadedFile as UploadedStatement } from './file-rows';

@Controller('insurer')
@UseGuards(InsurerAuthGuard)
export class ReconciliationController {
  constructor(private readonly recon: ReconciliationService) {}

  @Get('statement-mapping')
  mapping(@Req() req: InsurerRequest) {
    return this.recon.getMapping(req.insurerUser!);
  }

  @Post('statement-mapping')
  @InsurerRoles('operator', 'approver')
  @HttpCode(200)
  setMapping(@Req() req: InsurerRequest, @Body() body: Record<string, unknown>) {
    return this.recon.setMapping(req.insurerUser!, body ?? {});
  }

  /** Multipart upload, field "file", CSV or .xlsx up to 5 MB. PDFs go to statement-documents. Needs an Idempotency-Key. */
  @Post('statements')
  @InsurerRoles('operator', 'approver')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  upload(@Req() req: InsurerRequest, @UploadedFile() file: UploadedStatement | undefined) {
    return this.recon.upload(req.insurerUser!, file);
  }

  @Get('statements')
  statements(@Req() req: InsurerRequest) {
    return this.recon.listStatements(req.insurerUser!);
  }

  @Get('exceptions')
  exceptions(@Req() req: InsurerRequest, @Query('status') status?: string) {
    return this.recon.listExceptions(req.insurerUser!, status);
  }

  @Post('exceptions/:id/assign')
  @InsurerRoles('operator', 'approver')
  @HttpCode(200)
  assign(@Req() req: InsurerRequest, @Param('id') id: string) {
    return this.recon.assign(req.insurerUser!, id);
  }

  @Post('exceptions/:id/resolve')
  @InsurerRoles('operator', 'approver')
  @HttpCode(200)
  resolve(@Req() req: InsurerRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.recon.resolve(req.insurerUser!, id, body ?? {});
  }

  @Get('reports/daily-collections')
  daily(@Req() req: InsurerRequest, @Query() query: Record<string, unknown>) {
    return this.recon.dailyCollections(req.insurerUser!, query);
  }

  @Get('reports/exception-ageing')
  ageing(@Req() req: InsurerRequest) {
    return this.recon.exceptionAgeing(req.insurerUser!);
  }

  /** PDF statements are held for a person to read and transcribe; nothing is matched from a PDF automatically. */
  @Post('statement-documents')
  @InsurerRoles('operator', 'approver')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  uploadDocument(@Req() req: InsurerRequest, @UploadedFile() file: UploadedStatement | undefined) {
    return this.recon.uploadDocument(req.insurerUser!, file);
  }

  @Get('statement-documents')
  documents(@Req() req: InsurerRequest) {
    return this.recon.listDocuments(req.insurerUser!);
  }

  @Get('statement-documents/:id/content')
  @Header('Content-Type', 'application/pdf')
  @Header('X-Content-Type-Options', 'nosniff')
  async documentContent(@Req() req: InsurerRequest, @Param('id') id: string) {
    const doc = await this.recon.downloadDocument(req.insurerUser!, id);
    const safe = doc.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
    return new StreamableFile(doc.content, { type: 'application/pdf', disposition: `attachment; filename="${safe}"` });
  }

  /** A second person uploads the transcribed lines (CSV or .xlsx) for a held PDF; they are matched like any statement. */
  @Post('statement-documents/:id/transcription')
  @InsurerRoles('operator', 'approver')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  transcribe(@Req() req: InsurerRequest, @Param('id') id: string, @UploadedFile() file: UploadedStatement | undefined) {
    return this.recon.transcribeDocument(req.insurerUser!, id, file);
  }
}
