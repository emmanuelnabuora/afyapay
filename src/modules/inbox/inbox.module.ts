import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import { InboxService } from './inbox.service';

/**
 * inbox domain module. Owns the `inbox` schema: raw provider callbacks, stored
 * first and de-duplicated by provider reference.
 */
@Module({
  imports: [PlatformModule],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
