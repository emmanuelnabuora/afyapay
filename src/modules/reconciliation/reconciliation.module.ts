import { Module } from '@nestjs/common';
import { InsurerModule } from '../insurer/insurer.module';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

/**
 * reconciliation domain module. Owns the `reconciliation` schema: insurer
 * statements, their lines, the column mapping per insurer, and exceptions.
 */
@Module({
  imports: [InsurerModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
})
export class ReconciliationModule {}
