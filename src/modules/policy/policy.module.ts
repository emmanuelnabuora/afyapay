import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { PlatformModule } from '../platform/platform.module';
import { PolicyController } from './policy.controller';
import { PolicyLinkService } from './policy-link.service';

/**
 * policy domain module. Owns the `policy` schema: policy links now; premium
 * schedules and insurer cover events later (E5).
 */
@Module({
  imports: [IdentityModule, PlatformModule],
  controllers: [PolicyController],
  providers: [PolicyLinkService],
  exports: [PolicyLinkService],
})
export class PolicyModule {}
