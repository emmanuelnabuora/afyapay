import { Module } from '@nestjs/common';

/**
 * governance domain module. Owns the `governance` database schema; other modules
 * reach its data only through this module's exported services.
 */
@Module({})
export class GovernanceModule {}
