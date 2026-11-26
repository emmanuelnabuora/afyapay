/**
 * Synthetic data for tests, demos and staging. Never real people or insurers.
 *
 * - Insurers are fictional. Their names must never match a real company.
 * - Phone numbers use the +254 700 000 xxx block and every record carries
 *   `synthetic: true`; the SMS adapter must refuse to send to synthetic records.
 * - National IDs start with 00, which real Kenyan ID numbers do not use.
 * - Output is deterministic for a given seed, so tests are repeatable.
 */

export interface SyntheticInsurer {
  synthetic: true;
  code: string;
  name: string;
  paybill: string;
  products: Array<{ code: string; name: string; monthlyPremiumMinor: number }>;
}

export interface SyntheticCustomer {
  synthetic: true;
  ref: string;
  givenName: string;
  familyName: string;
  phone: string;
  nationalId: string;
  county: string;
}

export interface SyntheticPolicy {
  synthetic: true;
  policyNumber: string;
  insurerCode: string;
  productCode: string;
  customerRef: string;
  monthlyPremiumMinor: number;
  dailyAmountMinor: number;
}

export interface SyntheticDataset {
  seed: number;
  insurers: SyntheticInsurer[];
  customers: SyntheticCustomer[];
  policies: SyntheticPolicy[];
}

/** mulberry32: small, fast, deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INSURERS: Array<Omit<SyntheticInsurer, 'synthetic' | 'paybill'>> = [
  {
    code: 'PWANI',
    name: 'Pwani Mutual (fictional)',
    products: [
      { code: 'PM-HL', name: 'Afya Plus Family', monthlyPremiumMinor: 132_000 },
      { code: 'PM-IN', name: 'Afya Basic Individual', monthlyPremiumMinor: 99_000 },
    ],
  },
  {
    code: 'JAMII',
    name: 'Jamii Assurance (fictional)',
    products: [
      { code: 'JA-FB', name: 'Familia Basic', monthlyPremiumMinor: 115_000 },
      { code: 'JA-BD', name: 'Boda Cover', monthlyPremiumMinor: 45_000 },
    ],
  },
];

const GIVEN = ['Amani', 'Baraka', 'Chiku', 'Daudi', 'Eshe', 'Faraji', 'Imani', 'Jabari', 'Kesi', 'Lulu', 'Makena', 'Neema', 'Otieno', 'Pendo', 'Rehema', 'Sefu', 'Tumaini', 'Wanjiru', 'Zawadi', 'Kamau'];
const FAMILY = ['Sample', 'Testa', 'Mfano', 'Demo', 'Synth', 'Majaribio'];
const COUNTIES = ['Nairobi', 'Mombasa', 'Kisumu', 'Nakuru', 'Kiambu', 'Machakos'];

export function generateSyntheticData(opts: { seed?: number; customers?: number } = {}): SyntheticDataset {
  const seed = opts.seed ?? 42;
  const count = opts.customers ?? 20;
  if (count < 0 || count > 999) throw new RangeError('customers must be between 0 and 999');
  const rand = prng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

  const insurers: SyntheticInsurer[] = INSURERS.map((ins, i) => ({
    synthetic: true,
    ...ins,
    paybill: `00000${i + 1}`,
  }));

  const customers: SyntheticCustomer[] = [];
  const policies: SyntheticPolicy[] = [];
  for (let i = 0; i < count; i++) {
    const n = String(i + 1).padStart(3, '0');
    const customer: SyntheticCustomer = {
      synthetic: true,
      ref: `SYN-C-${n}`,
      givenName: pick(GIVEN),
      familyName: pick(FAMILY),
      phone: `+254700000${n}`,
      nationalId: `00${String(Math.floor(rand() * 1_000_000)).padStart(6, '0')}`,
      county: pick(COUNTIES),
    };
    customers.push(customer);

    const insurer = pick(insurers);
    const product = pick(insurer.products);
    policies.push({
      synthetic: true,
      policyNumber: `SYN-${product.code}-${String(100000 + i)}`,
      insurerCode: insurer.code,
      productCode: product.code,
      customerRef: customer.ref,
      monthlyPremiumMinor: product.monthlyPremiumMinor,
      // Daily amount rounds up to a whole shilling so 30 days always cover the month.
      dailyAmountMinor: Math.ceil(product.monthlyPremiumMinor / 30 / 100) * 100,
    });
  }

  return { seed, insurers, customers, policies };
}
