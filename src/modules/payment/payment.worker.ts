import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { CONFIRM_STK_JOB, InboxService, StkCallbackBody } from '../inbox/inbox.service';
import { JobQueueService } from '../platform/job-queue.service';
import { PaymentService } from './payment.service';
import { SIMULATED_CALLBACK_JOB } from './simulated.gateway';

/** Jobs claimed per batch, and how many full batches one tick may drain. */
const BATCH_SIZE = 10;
const MAX_BATCHES_PER_TICK = 20;

/** Still waiting on M-Pesa: retry the job without counting it as an error. */
class StillPending extends Error {}

/**
 * Runs payment jobs from the queue: confirming STK results and delivering the
 * simulated gateway's callbacks. Polls every few seconds outside tests; tests
 * call runOnce() directly.
 */
@Injectable()
export class PaymentWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('PaymentWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly jobs: JobQueueService,
    private readonly payments: PaymentService,
    private readonly inbox: InboxService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.APP_ENV === 'test' || process.env.PAYMENT_WORKER === 'off') return;
    this.timer = setInterval(() => void this.tick(), 3000);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // Keep draining while full batches come back, so a burst of payments is
      // confirmed in seconds rather than at 10 jobs per tick. The cap keeps one
      // tick from running forever if the queue never empties.
      for (let i = 0; i < MAX_BATCHES_PER_TICK && (await this.runOnce()) === BATCH_SIZE; i++);
    } catch (err) {
      this.log.error(`Payment worker tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Processes the jobs that are due now. Returns how many it handled. */
  async runOnce(): Promise<number> {
    const batch = await this.jobs.claim([CONFIRM_STK_JOB, SIMULATED_CALLBACK_JOB], BATCH_SIZE, 60);
    for (const job of batch) {
      try {
        if (job.kind === SIMULATED_CALLBACK_JOB) {
          await this.inbox.recordStkCallback(job.payload as StkCallbackBody);
        } else if ((await this.payments.confirm(String(job.payload.checkoutRequestId))) === 'pending') {
          throw new StillPending('M-Pesa has no final result yet');
        }
        await this.jobs.complete(job.id);
      } catch (err) {
        const outcome = await this.jobs.fail(job.id, (err as Error).message);
        if (!(err instanceof StillPending)) this.log.warn(`Job ${job.kind} ${job.id} failed (${outcome}): ${(err as Error).message}`);
      }
    }
    return batch.length;
  }
}
