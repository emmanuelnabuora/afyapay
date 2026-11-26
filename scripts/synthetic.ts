/**
 * Prints a synthetic dataset as JSON.
 *   npm run synthetic -- --seed 7 --customers 50 > data/synthetic/sample.json
 */
import { generateSyntheticData } from '../src/synthetic/generator';

function arg(name: string): number | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : undefined;
}

process.stdout.write(`${JSON.stringify(generateSyntheticData({ seed: arg('seed'), customers: arg('customers') }), null, 2)}\n`);
