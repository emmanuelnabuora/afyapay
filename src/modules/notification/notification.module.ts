import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { PaymentModule } from '../payment/payment.module';
import { PlatformModule } from '../platform/platform.module';
import { PolicyModule } from '../policy/policy.module';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { NotificationWorker } from './notification.worker';
import { SMS_GATEWAY, SuppressedSmsGateway } from './sms.gateway';

/**
 * notification domain module. Owns the `notification` schema: SMS and in-app
 * messages with their delivery status.
 */
@Module({
  imports: [IdentityModule, PlatformModule, PaymentModule, PolicyModule],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationWorker, { provide: SMS_GATEWAY, useClass: SuppressedSmsGateway }],
  exports: [NotificationService],
})
export class NotificationModule {}
