import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { CustomerAuthGuard, CustomerRequest } from '../identity/customer-auth.guard';
import { InboxService, StkCallbackBody } from '../inbox/inbox.service';
import { SkipIdempotency } from '../platform/idempotency.interceptor';
import { callbackSecretMatches, PaymentService } from './payment.service';

@Controller('me/payments')
@UseGuards(CustomerAuthGuard)
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Get()
  list(@Req() req: CustomerRequest) {
    return this.payments.listForCustomer(req.customer!.sub);
  }

  /** Sends an M-Pesa prompt to the customer's phone. Needs an Idempotency-Key. */
  @Post()
  start(@Req() req: CustomerRequest, @Body() body: Record<string, unknown>) {
    return this.payments.start(req.customer!.sub, body ?? {});
  }

  /** One payment, with its receipt once M-Pesa has confirmed it. */
  @Get(':id')
  get(@Req() req: CustomerRequest, @Param('id') id: string) {
    return this.payments.getForCustomer(req.customer!.sub, id);
  }
}

/**
 * Where Safaricom sends STK callbacks. The path carries a secret so strangers
 * cannot reach it, and the callback is only stored: a status query decides.
 */
@Controller('hooks/mpesa')
@SkipIdempotency()
export class MpesaHookController {
  constructor(private readonly inbox: InboxService) {}

  @Post('stk-callback/:secret')
  @HttpCode(200)
  async stkCallback(@Param('secret') secret: string, @Body() body: StkCallbackBody) {
    if (!callbackSecretMatches(secret)) throw new NotFoundException();
    await this.inbox.recordStkCallback(body);
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }
}
