import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { InsurerModule } from '../insurer/insurer.module';
import { InsurerPlansController, PlanInterestController, PlansController } from './catalogue.controller';
import { CatalogueService } from './catalogue.service';
import { InsurerPlansService } from './insurer-plans.service';

/**
 * catalogue domain module. Owns the `catalogue` schema: insurer-supplied
 * plans and the interest customers register in them (Journey 7, sandbox).
 * Buying stays off until launch gate G6 is closed and the switch approved.
 */
@Module({
  imports: [IdentityModule, InsurerModule],
  controllers: [PlansController, PlanInterestController, InsurerPlansController],
  providers: [CatalogueService, InsurerPlansService],
})
export class CatalogueModule {}
