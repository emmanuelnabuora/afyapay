import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

export const PG_POOL = Symbol('PG_POOL');

/** Thin wrapper so callers depend on an interface, not on pg directly. */
@Injectable()
export class Database implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
          throw new Error('DATABASE_URL is not set. Copy .env.example for local development.');
        }
        return new Pool({ connectionString, max: 10 });
      },
    },
    Database,
  ],
  exports: [Database],
})
export class DatabaseModule {}
