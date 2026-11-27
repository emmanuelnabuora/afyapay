import { Module } from '@nestjs/common';
import { AuthController, MeController } from './auth.controller';
import { AuthService } from './auth.service';
import { CustomerAuthGuard } from './customer-auth.guard';
import { SMS_SENDER, SuppressedSmsSender } from './sms';

/**
 * identity domain module. Owns the `identity` schema: customers, one-time
 * codes and sessions. Other modules use CustomerAuthGuard, never its tables.
 */
@Module({
  controllers: [AuthController, MeController],
  providers: [AuthService, CustomerAuthGuard, { provide: SMS_SENDER, useClass: SuppressedSmsSender }],
  exports: [CustomerAuthGuard],
})
export class IdentityModule {}
