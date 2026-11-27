export interface Track {
  state: string;
  label: string;
}
export interface Policy {
  policyLinkId: string;
  policyNumber: string;
  insurer: { code: string; name: string };
  money: Track & { at: string | null };
  premium: Track & { premiumMinor?: string; paidThisPeriodMinor?: string; behindByMinor?: string; dueDate?: string };
  cover: Track;
}
export interface PolicyLink {
  id: string;
  policyNumber: string;
  status: string;
  insurer: { code: string; name: string };
  rejectionReason?: string | null;
}
export interface Payment {
  id: string;
  policyNumber: string;
  insurer: { code: string; name: string };
  amountMinor: string;
  status: string;
  failure: { code: string; message: string } | null;
  receipt: { mpesaReceipt: string; confirmedAt: string } | null;
  createdAt: string;
}

export interface Plan {
  id: string;
  insurer: { code: string; name: string };
  code: string;
  name: string;
  coverType: 'health_individual' | 'health_family' | 'personal_accident';
  summary: string;
  household: { min: number; max: number };
  quote: { available: true; householdSize: number; monthlyMinor: string; currency: 'KES' } | { available: false; householdSize: number; reason: string };
  counties: string[];
  inpatientLimitMinor: string | null;
  outpatientLimitMinor: string | null;
  waitingPeriodDays: number;
  benefits: string[];
  exclusions: string[];
  sponsored: boolean;
  label: string | null;
  source: string;
}

export interface BuyingStatus {
  buyingAvailable: boolean;
  notice: string | null;
}

export interface PlanInterest {
  id: string;
  status: 'new' | 'contacted' | 'closed';
  plan: { id: string; name: string; insurer: string };
  householdSize: number;
  county: string | null;
  quotedMonthlyMinor: string;
  createdAt: string;
}
