import { coverView, eatDate, kes, moneyView, periodStart, premiumPosition } from './tracks';

const monthly = { frequency: 'monthly' as const, amountMinor: 300000n, startsOn: '2027-01-15' };

describe('premium position', () => {
  it('counts calendar months, clamping to the last day', () => {
    expect(periodStart('monthly', '2027-01-31', 1)).toBe('2027-02-28');
    expect(periodStart('weekly', '2027-01-01', 2)).toBe('2027-01-15');
    expect(periodStart('annual', '2028-02-29', 1)).toBe('2029-02-28');
  });

  it('shows saving towards the premium within the current period', () => {
    const p = premiumPosition(monthly, 100000n, 'Pwani Mutual (fictional)', '2027-01-20');
    expect(p).toMatchObject({ state: 'part_paid', label: 'Saved towards your premium: KES 1,000 of KES 3,000', dueDate: '2027-02-14', daysToDueDate: 25 });
  });

  it('is fully paid once the period premium is reached', () => {
    expect(premiumPosition(monthly, 300000n, 'Pwani Mutual (fictional)', '2027-02-14')).toMatchObject({ state: 'fully_paid', label: 'Full premium paid to Pwani Mutual (fictional)' });
  });

  it('is behind schedule when an earlier due date passed unpaid, and arrears come first', () => {
    const p = premiumPosition(monthly, 400000n, 'Pwani Mutual (fictional)', '2027-03-20');
    // Two periods due by 14 Mar (KES 6,000); KES 4,000 paid.
    expect(p).toMatchObject({ state: 'behind_schedule', behindByMinor: '200000', label: 'Behind by KES 2,000. 25 days to due date.', paidThisPeriodMinor: '0' });
  });

  it('handles daily plans and plans that have not started', () => {
    const daily = { frequency: 'daily' as const, amountMinor: 5000n, startsOn: '2027-01-01' };
    expect(premiumPosition(daily, 15000n, 'X', '2027-01-03').state).toBe('fully_paid');
    expect(premiumPosition(daily, 10000n, 'X', '2027-01-03')).toMatchObject({ state: 'part_paid', daysToDueDate: 0 });
    expect(premiumPosition(daily, 5000n, 'X', '2027-01-03')).toMatchObject({ state: 'behind_schedule', label: 'Behind by KES 50. 0 days to due date.' });
    expect(premiumPosition(monthly, 0n, 'X', '2027-01-01').state).toBe('not_started');
  });

  it('never uses cover words on the premium or money track', () => {
    const labels = [
      premiumPosition(monthly, 0n, 'X', '2027-01-20').label,
      premiumPosition(monthly, 300000n, 'X', '2027-01-20').label,
      premiumPosition(monthly, 0n, 'X', '2027-03-20').label,
      moneyView({ status: 'confirmed', amountMinor: 100n, failureMessage: null, at: new Date() }, 'X').label,
      moneyView({ status: 'failed', amountMinor: 100n, failureMessage: 'You cancelled the M-Pesa prompt.', at: new Date() }, 'X').label,
      moneyView({ status: 'prompt_sent', amountMinor: 100n, failureMessage: null, at: new Date() }, 'X').label,
    ];
    for (const l of labels) expect(l).not.toMatch(/cover|protect|insured/i);
  });
});

describe('cover view', () => {
  const at = (d: string) => new Date(`${d}T09:00:00+03:00`);

  it('is not active until the insurer says so', () => {
    expect(coverView(null, 'Pwani Mutual (fictional)', '2027-01-20')).toMatchObject({ state: 'not_active', label: 'Not covered yet. Pwani Mutual (fictional) activates cover.' });
  });

  it('is active with the insurer and date named', () => {
    const v = coverView({ status: 'active', coveredUntil: '2027-02-14', effectiveOn: '2027-01-15', recordedAt: at('2027-01-16') }, 'Pwani', '2027-01-20');
    expect(v).toMatchObject({ state: 'active', label: 'Covered until 2027-02-14. Confirmed by Pwani on 2027-01-16.', source: 'insurer' });
  });

  it('stops saying covered when the confirmation is old or the end date has passed', () => {
    expect(coverView({ status: 'active', coveredUntil: '2027-12-31', effectiveOn: '2027-01-01', recordedAt: at('2027-01-01') }, 'Pwani', '2027-03-01')).toMatchObject({ state: 'stale', label: 'Last confirmed by Pwani on 2027-01-01' });
    expect(coverView({ status: 'active', coveredUntil: '2027-01-31', effectiveOn: '2027-01-01', recordedAt: at('2027-01-20') }, 'Pwani', '2027-02-01').state).toBe('stale');
  });

  it('shows lapsed and ended per the insurer', () => {
    expect(coverView({ status: 'lapsed', coveredUntil: null, effectiveOn: '2027-02-15', recordedAt: at('2027-02-16') }, 'Pwani', '2027-02-20').label).toBe('Cover lapsed on 2027-02-15, per Pwani');
    expect(coverView({ status: 'ended', coveredUntil: null, effectiveOn: '2027-06-30', recordedAt: at('2027-06-30') }, 'Pwani', '2027-07-01').state).toBe('ended');
  });
});

describe('formatting', () => {
  it('shows whole KES, rounding up, and East Africa dates', () => {
    expect(kes(123456700n)).toBe('KES 1,234,567');
    expect(kes(150n)).toBe('KES 2');
    expect(eatDate(new Date('2027-01-11T22:30:00Z'))).toBe('2027-01-12');
  });
});
