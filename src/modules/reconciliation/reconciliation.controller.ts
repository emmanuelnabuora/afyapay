import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InsurerAuthGuard, InsurerRequest, InsurerRoles } from '../insurer/insurer-auth.guard';
import { ReconciliationService } from './reconciliation.service';

interface UploadedStatement {
  originalname: string;
  buffer: Buffer;
}

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

  /** Multipart upload, field "file", CSV up to 5 MB. Needs an Idempotency-Key. */
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
}
