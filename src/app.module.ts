import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { CatalogueModule } from './modules/catalogue/catalogue.module';
import { HealthController } from './health.controller';
import { GovernanceModule } from './modules/governance/governance.module';
import { IdentityModule } from './modules/identity/identity.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { InsurerModule } from './modules/insurer/insurer.module';
import { NotificationModule } from './modules/notification/notification.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { PaymentModule } from './modules/payment/payment.module';
import { PlatformModule } from './modules/platform/platform.module';
import { PolicyModule } from './modules/policy/policy.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';

@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    InsurerModule,
    PolicyModule,
    PaymentModule,
    InboxModule,
    LedgerModule,
    NotificationModule,
    ReconciliationModule,
    PlatformModule,
    GovernanceModule,
    CatalogueModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
