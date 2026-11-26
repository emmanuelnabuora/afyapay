import { Module } from '@nestjs/common';

/**
 * identity domain module. Owns the `identity` database schema; other modules
 * reach its data only through this module's exported services.
 */
@Module({})
export class IdentityModule {}
