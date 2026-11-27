import { Pool } from 'pg';
import { CONFIRM_STK_JOB } from '../../src/modules/inbox/inbox.service';
import { PaymentWorker } from '../../src/modules/payment/payment.worker';
import { SIMULATED_CALLBACK_JOB } from '../../src/modules/payment/simulated.gateway';

/**
 * Runs one payment's jobs until the payment leaves "prompt sent", or until
 * nothing of it is left to run. Test files run in parallel and their workers
 * share the queue, so another file's worker may be holding a job: keep making
 * this payment's jobs due and wait for them instead of giving up.
 */
export async function settlePayment(pool: Pool, worker: PaymentWorker, checkoutRequestId: string, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await pool.query(
      `update platform.job set run_at = now() where status = 'queued' and kind = any($1)
         and (payload->>'checkoutRequestId' = $2 or payload->'Body'->'stkCallback'->>'CheckoutRequestID' = $2)`,
      [[CONFIRM_STK_JOB, SIMULATED_CALLBACK_JOB], checkoutRequestId],
    );
    await worker.runOnce();
    const { rows } = await pool.query<{ status: string; open_jobs: number }>(
      `select p.status,
              (select count(*)::int from platform.job j where j.status in ('queued', 'running') and j.kind = any($2)
                  and (j.payload->>'checkoutRequestId' = $1 or j.payload->'Body'->'stkCallback'->>'CheckoutRequestID' = $1)) as open_jobs
         from payment.stk_request s join payment.payment_intent p on p.id = s.payment_intent_id
        where s.checkout_request_id = $1`,
      [checkoutRequestId, [CONFIRM_STK_JOB, SIMULATED_CALLBACK_JOB]],
    );
    if (!rows[0] || rows[0].status !== 'prompt_sent' || rows[0].open_jobs === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}
