import { Module } from '@nestjs/common';

/**
 * ledger domain module. Owns the `ledger` database schema; other modules
 * reach its data only through this module's exported services.
 */
@Module({})
export class LedgerModule {}
