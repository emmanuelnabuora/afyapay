import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { InboxModule } from '../inbox/inbox.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PlatformModule } from '../platform/platform.module';
import { GatewayResolver } from './gateway.resolver';
import { MpesaHookController, PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentWorker } from './payment.worker';
import { SimulatedMpesaGateway } from './simulated.gateway';

/**
 * payment domain module. Owns the `payment` schema: payment intents, STK
 * requests and confirmed results. Money goes to the insurer's paybill only.
 */
@Module({
  imports: [IdentityModule, PlatformModule, InboxModule, LedgerModule],
  controllers: [PaymentController, MpesaHookController],
  providers: [SimulatedMpesaGateway, GatewayResolver, PaymentService, PaymentWorker],
  exports: [PaymentService],
})
export class PaymentModule {}
