import type { Plan } from './types';
import { kes } from './api';

export const COVER_TYPES: { value: Plan['coverType']; label: string }[] = [
  { value: 'health_individual', label: 'Health cover for one person' },
  { value: 'health_family', label: 'Health cover for a family' },
  { value: 'personal_accident', label: 'Personal accident cover' },
];
export const coverLabel = (t: string) => COVER_TYPES.find((c) => c.value === t)?.label ?? t;

export const limit = (minor: string | null) => (minor ? kes(minor) : 'Not stated');
export const waiting = (days: number) => (days === 0 ? 'None' : `${days} days`);
export const monthly = (p: Plan) => (p.quote.available ? `${kes(p.quote.monthlyMinor)} a month` : p.quote.reason);

/** What the customer searched for, kept while they move between search, details and compare. */
export interface Filters {
  coverType: string;
  householdSize: number;
  county: string;
  budgetKes: string;
}
export const filters: Filters = { coverType: '', householdSize: 1, county: '', budgetKes: '' };
export const compareIds = new Set<string>();
export const MAX_COMPARE = 3;
