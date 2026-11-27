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
