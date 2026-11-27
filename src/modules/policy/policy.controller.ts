import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { CustomerAuthGuard, CustomerRequest } from '../identity/customer-auth.guard';
import { PolicyLinkService } from './policy-link.service';

@Controller()
@UseGuards(CustomerAuthGuard)
export class PolicyController {
  constructor(private readonly links: PolicyLinkService) {}

  /** Insurers a customer can link a policy with. */
  @Get('insurers')
  insurers() {
    return this.links.listInsurers();
  }

  /** The consent wording to show before linking, with its version. */
  @Get('insurers/:code/consent')
  async consent(@Param('code') code: string) {
    const insurer = (await this.links.listInsurers()).find((i) => i.code === code);
    return this.links.consentText(insurer?.name ?? 'your insurer');
  }

  @Get('me/policy-links')
  list(@Req() req: CustomerRequest) {
    return this.links.listForCustomer(req.customer!.sub);
  }

  @Post('me/policy-links')
  request(@Req() req: CustomerRequest, @Body() body: Record<string, unknown>) {
    return this.links.requestLink(req.customer!.sub, body ?? {});
  }
}
