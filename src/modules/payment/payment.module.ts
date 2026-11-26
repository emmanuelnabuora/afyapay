import { Module } from '@nestjs/common';

/**
 * payment domain module. Owns the `payment` database schema; other modules
 * reach its data only through this module's exported services.
 */
@Module({})
export class PaymentModule {}
