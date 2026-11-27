import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { OutboxService } from '../platform/outbox.service';
import { NotificationService } from './notification.service';

/**
 * Reads the outbox into messages, runs reminders once an hour and sends SMS
 * that are due. Polls outside tests; tests call runOnce() directly.
 */
@Injectable()
export class NotificationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('NotificationWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastReminderRun = 0;

  constructor(
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.APP_ENV === 'test' || process.env.NOTIFICATION_WORKER === 'off') return;
    this.timer = setInterval(() => void this.tick(), 5000);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
      if (Date.now() - this.lastReminderRun > 3600_000) {
        await this.notifications.runReminders();
        this.lastReminderRun = Date.now();
      }
    } catch (err) {
      this.log.error(`Notification tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async runOnce(): Promise<void> {
    await this.outbox.relay((event) => this.notifications.handleEvent(event));
    await this.notifications.sendDue();
  }
}
