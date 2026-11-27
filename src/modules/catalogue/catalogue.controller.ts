import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CustomerAuthGuard, CustomerRequest } from '../identity/customer-auth.guard';
import { InsurerAuthGuard, InsurerRequest, InsurerRoles } from '../insurer/insurer-auth.guard';
import { CatalogueService } from './catalogue.service';
import { KENYAN_COUNTIES } from './counties';
import { InsurerPlansService } from './insurer-plans.service';

/** Public, read-only: anyone can find and compare plans. Sandbox insurers only before go-live. */
@Controller('plans')
export class PlansController {
  constructor(private readonly catalogue: CatalogueService) {}

  /** ?householdSize=&budgetMinor=&county=&coverType= */
  @Get()
  search(@Query() query: Record<string, unknown>) {
    return this.catalogue.search(query);
  }

  @Get('status')
  status() {
    return this.catalogue.status();
  }

  @Get('counties')
  counties() {
    return KENYAN_COUNTIES;
  }

  /** ?ids=a,b[,c]&householdSize= */
  @Get('compare')
  compare(@Query('ids') ids?: string, @Query('householdSize') householdSize?: string) {
    return this.catalogue.compare(ids, householdSize);
  }

  @Get(':id')
  get(@Param('id') id: string, @Query('householdSize') householdSize?: string) {
    return this.catalogue.get(id, householdSize);
  }

  /** The exact consent wording for registering interest in this plan, with its version. */
  @Get(':id/interest-consent')
  consent(@Param('id') id: string) {
    return this.catalogue.interestConsent(id);
  }
}

@Controller('me/plan-interests')
@UseGuards(CustomerAuthGuard)
export class PlanInterestController {
  constructor(private readonly catalogue: CatalogueService) {}

  /** {planId, householdSize, county?, consent: true, consentTextVersion}. Needs an Idempotency-Key. */
  @Post()
  register(@Req() req: CustomerRequest, @Body() body: Record<string, unknown>) {
    return this.catalogue.registerInterest(req.customer!.sub, body ?? {});
  }

  @Get()
  mine(@Req() req: CustomerRequest) {
    return this.catalogue.myInterests(req.customer!.sub);
  }
}

@Controller('insurer')
@UseGuards(InsurerAuthGuard)
export class InsurerPlansController {
  constructor(private readonly plans: InsurerPlansService) {}

  @Get('plans')
  list(@Req() req: InsurerRequest) {
    return this.plans.list(req.insurerUser!);
  }

  /** Publishes a plan, or updates the one with the same code. Needs an Idempotency-Key. */
  @Post('plans')
  @InsurerRoles('operator', 'approver')
  @HttpCode(200)
  upsert(@Req() req: InsurerRequest, @Body() body: Record<string, unknown>) {
    return this.plans.upsert(req.insurerUser!, body ?? {});
  }

  @Post('plans/:code/withdraw')
  @InsurerRoles('operator', 'approver')
  @HttpCode(200)
  withdraw(@Req() req: InsurerRequest, @Param('code') code: string) {
    return this.plans.withdraw(req.insurerUser!, code);
  }

  @Get('plan-interests')
  interests(@Req() req: InsurerRequest, @Query('status') status?: string) {
    return this.plans.interests(req.insurerUser!, status);
  }

  @Post('plan-interests/:id/status')
  @InsurerRoles('operator', 'approver')
  @HttpCode(200)
  updateInterest(@Req() req: InsurerRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.plans.updateInterest(req.insurerUser!, id, body ?? {});
  }
}
