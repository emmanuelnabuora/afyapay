# Load test (E10)

**Result:** pass. The API handled 200 requests a second, about 40 times our 10x pilot target, with no errors. p95 latency stayed under 20 ms. Confirmed payments settled in 7 s at p95.

## Target

No pilot volume is written down yet. This test assumes:

- 5,000 linked policies in the pilot
- each customer opens the app about 4 times a month at 8 requests a visit
- the busiest hour carries 10% of a day's traffic, with salary days at 3x

That comes to about 0.4 requests a second at peak. Ten times that is 4 to 5 requests a second. **The founder should confirm or correct the volume**, and the test is cheap to run again.

## How it was run

`npm run load-test -- --customers 400 --stages 5,10,25,50,100,200 --seconds 60` (script: `scripts/load-test.ts`).

- **Data:** synthetic only. The script refuses any host other than localhost and any `APP_ENV` other than development or test.
- **Setup:** it signs in 400 synthetic customers (`+254700000500` to `+254700000899`). Each one links a Pwani Mutual policy (`SYN-LOAD-<run>-n`). A synthetic insurer operator confirms each link and sets a monthly premium.
- **Traffic mix:**

  | Request | Share |
  |---|---|
  | View policies | 35% |
  | View one policy | 15% |
  | Browse plans | 20% |
  | Messages | 10% |
  | Payment history | 10% |
  | Start an M-Pesa payment (KES 100, simulated) | 10% |

- **Settling:** every payment is followed until it settles, through the simulated callback, inbox, status query and ledger, exactly as in production.
- **Machine:** one Node process on 4 vCPU and 16 GB, with PostgreSQL 16 on the same machine. The run date was 27 Nov 2026.

## Results

| Target rate | Requests | p50 | p95 | p99 | Errors (5xx or 429) | Rejected (other 4xx) |
|---|---|---|---|---|---|---|
| 5/s | 299 | 7 ms | 16 ms | 23 ms | 0 | 0 |
| 10/s | 599 | 6 ms | 15 ms | 22 ms | 0 | 0 |
| 25/s | 1,499 | 6 ms | 16 ms | 21 ms | 0 | 0 |
| 50/s | 2,999 | 5 ms | 14 ms | 18 ms | 0 | 0 |
| 100/s | 5,998 | 5 ms | 13 ms | 17 ms | 0 | 0 |
| 200/s | 11,999 | 6 ms | 14 ms | 18 ms | 0 | 0 |

Payments: 1,956 started and all 1,956 settled. Time from starting a payment to a final status was 5.0 s at p50 and 7.0 s at p95. The simulator itself waits 3 s before it sends the callback.

## Found and fixed

The first run settled payments at 13 s p50 and **65 s p95**. The payment worker took only 10 jobs every 3 seconds, which is about 1.7 payments a second, so a burst built a queue. The worker now keeps taking batches while they come back full, up to 200 jobs a tick (`src/modules/payment/payment.worker.ts`).

## Limits of this test

- **Hardware:** it ran on a development machine, not the production instance. Repeat it on the production-sized environment before the pilot, against a synthetic copy and never with real customers.
- **M-Pesa:** the simulator answers instantly. Real Daraja latency and its rate limits are untested until sandbox credentials exist.
- **Rate limiting:** the API has no general per-client rate limit; only sign-in is limited. The pen test is likely to raise this. Add one at the edge or in the app before the pilot.
