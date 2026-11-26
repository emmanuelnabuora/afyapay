import { Module } from '@nestjs/common';

/**
 * inbox domain module. Owns the `inbox` database schema; other modules
 * reach its data only through this module's exported services.
 */
@Module({})
export class InboxModule {}
