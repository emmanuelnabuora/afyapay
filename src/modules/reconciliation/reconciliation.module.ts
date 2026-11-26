import { Module } from '@nestjs/common';

/**
 * reconciliation domain module. Owns the `reconciliation` database schema; other modules
 * reach its data only through this module's exported services.
 */
@Module({})
export class ReconciliationModule {}
