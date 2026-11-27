import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { CustomerAuthGuard, CustomerRequest } from '../identity/customer-auth.guard';
import { NotificationService } from './notification.service';

@Controller('me')
@UseGuards(CustomerAuthGuard)
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  /** The in-app inbox: every message, including ones not sent by SMS. */
  @Get('messages')
  messages(@Req() req: CustomerRequest) {
    return this.notifications.inbox(req.customer!.sub);
  }

  @Get('preferences')
  preferences(@Req() req: CustomerRequest) {
    return this.notifications.preferences(req.customer!.sub);
  }

  /** SMS reminders on or off. Needs an Idempotency-Key. */
  @Post('preferences')
  setPreferences(@Req() req: CustomerRequest, @Body() body: Record<string, unknown>) {
    return this.notifications.setPreferences(req.customer!.sub, body ?? {});
  }
}
