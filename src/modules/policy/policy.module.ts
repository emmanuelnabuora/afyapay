import { Module } from '@nestjs/common';

/**
 * policy domain module. Owns the `policy` database schema; other modules
 * reach its data only through this module's exported services.
 */
@Module({})
export class PolicyModule {}
