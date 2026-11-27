import { afterQuietHours } from './notification.service';
import { ESSENTIAL, KISWAHILI_REVIEWED, Language, reason, render, SMS_MAX, TEMPLATE_NAMES } from './templates';

const longest = {
  code: '123456',
  amount: 'KES 150,000',
  insurer: 'A Very Long Fictional Insurer Name Limited (fictional)',
  receipt: 'SIMABCDEFG',
  reason: reason('prompt_not_sent', 'sw'),
  paid: 'KES 149,999',
  premium: 'KES 150,000',
  dueDate: '2027-12-31',
  behind: 'KES 150,000',
  days: '30',
};

describe('message templates', () => {
  it.each(TEMPLATE_NAMES.flatMap((t) => (['en', 'sw'] as Language[]).map((l) => [t, l] as const)))('%s (%s) fits one SMS with the longest values', (t, l) => {
    const body = render(t, l, { ...longest, reason: reason('prompt_not_sent', l) });
    expect(body.length).toBeLessThanOrEqual(SMS_MAX);
    expect(body).not.toMatch(/undefined|\$\{/);
  });

  it('never says covered, protected or insured, and never asks for a PIN to be shared', () => {
    for (const t of TEMPLATE_NAMES) {
      for (const l of ['en', 'sw'] as Language[]) {
        const body = render(t, l, longest);
        expect(body).not.toMatch(/cover|protect|insured/i);
        expect(body).not.toMatch(/(send|share|reply with|tuma).{0,20}PIN/i);
      }
    }
  });

  it('uses the fixed wording for premium and money', () => {
    expect(render('premium_reminder', 'en', longest)).toContain('Saved towards your');
    expect(render('premium_overdue', 'en', longest)).toContain('Behind by KES 150,000');
    expect(render('payment_confirmed', 'en', longest)).toContain('KES 150,000 paid to');
    expect(render('payment_failed', 'en', { reason: reason('cancelled', 'en') })).toBe("AfyaPay: Payment didn't go through: You cancelled the M-Pesa prompt.");
  });

  it('marks reminders as non-essential and the Kiswahili as not yet reviewed', () => {
    expect(ESSENTIAL.premium_reminder).toBe(false);
    expect(ESSENTIAL.premium_overdue).toBe(false);
    expect(ESSENTIAL.payment_confirmed).toBe(true);
    expect(KISWAHILI_REVIEWED).toBe(false);
  });
});

describe('quiet hours (21:00 to 08:00 East Africa Time)', () => {
  it('holds evening and early messages until 08:00 EAT', () => {
    expect(afterQuietHours(new Date('2027-01-11T10:00:00Z')).toISOString()).toBe('2027-01-11T10:00:00.000Z'); // 13:00 EAT
    expect(afterQuietHours(new Date('2027-01-11T19:30:00Z')).toISOString()).toBe('2027-01-12T05:00:00.000Z'); // 22:30 EAT
    expect(afterQuietHours(new Date('2027-01-11T02:00:00Z')).toISOString()).toBe('2027-01-11T05:00:00.000Z'); // 05:00 EAT
  });
});
