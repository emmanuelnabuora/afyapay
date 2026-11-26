import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Database } from './database/database.module';

@Controller('health')
export class HealthController {
  constructor(private readonly db: Database) {}

  @Get()
  async check(): Promise<{ status: 'ok'; database: 'up' }> {
    if (!(await this.db.ping())) {
      throw new ServiceUnavailableException({ status: 'degraded', database: 'down' });
    }
    return { status: 'ok', database: 'up' };
  }
}
