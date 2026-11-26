import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';
import { JobQueueService } from './job-queue.service';
import { OutboxService } from './outbox.service';

/**
 * platform domain module. Owns the `platform` schema: idempotency keys,
 * the transactional outbox and the job queue.
 */
@Module({
  providers: [
    IdempotencyService,
    OutboxService,
    JobQueueService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [IdempotencyService, OutboxService, JobQueueService],
})
export class PlatformModule {}
