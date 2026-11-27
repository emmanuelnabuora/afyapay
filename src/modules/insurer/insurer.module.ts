import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import { PolicyModule } from '../policy/policy.module';
import { CoverBatchService } from './cover-batch.service';
import { CoverBatchController, InsurerAuthController, InsurerPortalController } from './insurer.controller';
import { InsurerAuthGuard } from './insurer-auth.guard';
import { InsurerAuthService } from './insurer-auth.service';
import { InsurerPortalService } from './insurer-portal.service';
import { InsurerScope } from './insurer-scope';

/**
 * insurer domain module. Owns the `insurer` schema: insurers, their paybills
 * and their staff, and the insurer portal API.
 */
@Module({
  imports: [PlatformModule, PolicyModule],
  controllers: [InsurerAuthController, InsurerPortalController, CoverBatchController],
  providers: [InsurerAuthService, InsurerAuthGuard, InsurerScope, InsurerPortalService, CoverBatchService],
  exports: [InsurerScope, InsurerAuthGuard],
})
export class InsurerModule {}
