import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';

/**
 * ledger domain module. Owns the `ledger` schema: the Collections memo book
 * (money that went straight to insurers) and the Revenue book.
 */
@Module({
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
