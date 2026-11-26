import { Module } from '@nestjs/common';

/**
 * insurer domain module. Owns the `insurer` database schema; other modules
 * reach its data only through this module's exported services.
 */
@Module({})
export class InsurerModule {}
