import { Module } from '@nestjs/common';
import { GovernanceController, StaffAuthController } from './governance.controller';
import { GovernanceService } from './governance.service';
import { StaffAuthGuard } from './staff-auth.guard';
import { StaffAuthService } from './staff-auth.service';

/**
 * governance domain module. Owns the `governance` schema: AfyaPay staff and
 * their roles, maker-checker approval requests, settings, launch gates and the
 * audit log.
 */
@Module({
  controllers: [StaffAuthController, GovernanceController],
  providers: [StaffAuthService, StaffAuthGuard, GovernanceService],
  exports: [StaffAuthGuard, GovernanceService],
})
export class GovernanceModule {}
