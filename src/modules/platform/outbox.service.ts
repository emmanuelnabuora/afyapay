import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';

export interface OutboxMessage {
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export interface OutboxEvent extends OutboxMessage {
  id: string;
  createdAt: Date;
}

@Injectable()
export class OutboxService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Records an event inside the caller's open transaction. If that transaction
   * rolls back, the event disappears with it; if it commits, the event is sent.
   */
  async enqueue(tx: PoolClient, message: OutboxMessage): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      'insert into platform.outbox_event (topic, aggregate_type, aggregate_id, payload) values ($1, $2, $3, $4) returning id',
      [message.topic, message.aggregateType, message.aggregateId, JSON.stringify(message.payload)],
    );
    return rows[0].id;
  }

  /**
   * Publishes up to `limit` unpublished events in creation order. Each event is
   * marked published only after the handler succeeds; a failure is recorded and
   * retried on the next run. Safe to run from several workers at once.
   */
  async relay(handler: (event: OutboxEvent) => Promise<void>, limit = 50): Promise<{ published: number; failed: number }> {
    const client = await this.pool.connect();
    let published = 0;
    let failed = 0;
    try {
      await client.query('begin');
      const { rows } = await client.query<{
        id: string;
        topic: string;
        aggregate_type: string;
        aggregate_id: string;
        payload: Record<string, unknown>;
        created_at: Date;
      }>(
        `select id, topic, aggregate_type, aggregate_id, payload, created_at
           from platform.outbox_event
          where published_at is null
          order by created_at
          limit $1
          for update skip locked`,
        [limit],
      );
      for (const r of rows) {
        try {
          await handler({ id: r.id, topic: r.topic, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id, payload: r.payload, createdAt: r.created_at });
          await client.query('update platform.outbox_event set published_at = now(), attempts = attempts + 1, last_error = null where id = $1', [r.id]);
          published++;
        } catch (err) {
          await client.query('update platform.outbox_event set attempts = attempts + 1, last_error = $2 where id = $1', [r.id, String((err as Error).message).slice(0, 1000)]);
          failed++;
        }
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
    return { published, failed };
  }
}
