import { Module } from '@nestjs/common';

/**
 * platform domain module. Owns the `platform` database schema; other modules
 * reach its data only through this module's exported services.
 */
@Module({})
export class PlatformModule {}
