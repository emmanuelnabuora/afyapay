import { generateSyntheticData } from './generator';

describe('synthetic data', () => {
  it('is deterministic for a seed', () => {
    expect(generateSyntheticData({ seed: 7, customers: 10 })).toEqual(generateSyntheticData({ seed: 7, customers: 10 }));
    expect(generateSyntheticData({ seed: 7 })).not.toEqual(generateSyntheticData({ seed: 8 }));
  });

  it('marks every record synthetic and labels insurers as fictional', () => {
    const d = generateSyntheticData({ customers: 50 });
    for (const r of [...d.insurers, ...d.customers, ...d.policies]) expect(r.synthetic).toBe(true);
    for (const i of d.insurers) expect(i.name).toMatch(/\(fictional\)$/);
  });

  it('uses reserved-looking identifiers and integer money', () => {
    const d = generateSyntheticData({ customers: 50 });
    for (const c of d.customers) {
      expect(c.phone).toMatch(/^\+254700000\d{3}$/);
      expect(c.nationalId).toMatch(/^00\d{6}$/);
    }
    for (const p of d.policies) {
      expect(Number.isInteger(p.monthlyPremiumMinor)).toBe(true);
      expect(Number.isInteger(p.dailyAmountMinor)).toBe(true);
      expect(p.dailyAmountMinor * 30).toBeGreaterThanOrEqual(p.monthlyPremiumMinor);
      expect(d.customers.some((c) => c.ref === p.customerRef)).toBe(true);
    }
  });
});
