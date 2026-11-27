import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { JobQueueService } from '../platform/job-queue.service';

export const CONFIRM_STK_JOB = 'mpesa.confirm_stk';

export interface StkCallbackBody {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResultCode?: number;
      ResultDesc?: string;
      CallbackMetadata?: { Item?: Array<{ Name: string; Value?: string | number }> };
    };
  };
}

/**
 * Stores every provider callback before acting on it, and never trusts it on
 * its own: storing it only schedules a status query that confirms the result.
 */
@Injectable()
export class InboxService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly jobs: JobQueueService,
  ) {}

  /** Returns false if the payload is not an STK callback. Duplicates are ignored. */
  async recordStkCallback(body: StkCallbackBody): Promise<boolean> {
    const checkoutRequestId = body?.Body?.stkCallback?.CheckoutRequestID;
    if (typeof checkoutRequestId !== 'string' || checkoutRequestId.length === 0 || checkoutRequestId.length > 100) return false;
    await this.pool.query(
      `insert into inbox.provider_callback (provider, kind, provider_reference, payload)
       values ('mpesa', 'stk_callback', $1, $2)
       on conflict (provider, kind, provider_reference) do nothing`,
      [checkoutRequestId, JSON.stringify(body)],
    );
    await this.jobs.enqueue(CONFIRM_STK_JOB, { checkoutRequestId }, { dedupeKey: `confirm-cb:${checkoutRequestId}` });
    return true;
  }

  async stkCallback(checkoutRequestId: string): Promise<StkCallbackBody | null> {
    const { rows } = await this.pool.query<{ payload: StkCallbackBody }>(
      "select payload from inbox.provider_callback where provider = 'mpesa' and kind = 'stk_callback' and provider_reference = $1",
      [checkoutRequestId],
    );
    return rows[0]?.payload ?? null;
  }
}

/** Reads a named item from an STK callback's metadata. */
export function callbackItem(body: StkCallbackBody | null, name: string): string | number | undefined {
  return body?.Body?.stkCallback?.CallbackMetadata?.Item?.find((i) => i.Name === name)?.Value;
}
