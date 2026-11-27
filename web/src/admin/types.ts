export type Role = 'support' | 'finance' | 'compliance' | 'super_admin';
export interface Me { id: string; email: string; roles: Role[] }
export const ROLE_LABEL: Record<Role, string> = { support: 'Support', finance: 'Finance', compliance: 'Compliance', super_admin: 'Super administrator' };
export const has = (me: Me, ...roles: Role[]) => roles.some((r) => me.roles.includes(r));

export interface Staff { id: string; email: string; displayName: string; status: string; mfaEnrolled: boolean; roles: Role[]; createdAt: string }
export interface Gate { code: string; title: string; neededFor: 'pilot' | 'later'; status: 'open' | 'closed'; evidenceCount?: number; lastChange?: { status: string; note: string; by: string; at: string } | null }
export interface Request {
  id: string;
  kind: 'role_grant' | 'role_revoke' | 'setting_change' | 'customer_unmask';
  payload: Record<string, unknown>;
  reason: string;
  status: 'proposed' | 'approved' | 'rejected' | 'withdrawn';
  decisionNote: string | null;
  proposedBy: { id: string; email: string };
  decidedBy: { id: string; email: string } | null;
  createdAt: string;
  decidedAt: string | null;
}
