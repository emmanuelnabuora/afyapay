import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { PaymentModule } from '../payment/payment.module';
import { PlatformModule } from '../platform/platform.module';
import { MyPoliciesController, PolicyController } from './policy.controller';
import { PolicyLinkService } from './policy-link.service';
import { PolicyTracksService } from './policy-tracks.service';

/**
 * policy domain module. Owns the `policy` schema: policy links, the insurer's
 * premium plans and insurer-reported cover events.
 */
@Module({
  imports: [IdentityModule, PlatformModule, PaymentModule],
  controllers: [PolicyController, MyPoliciesController],
  providers: [PolicyLinkService, PolicyTracksService],
  exports: [PolicyLinkService, PolicyTracksService],
})
export class PolicyModule {}
