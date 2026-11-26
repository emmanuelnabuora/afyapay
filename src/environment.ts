/**
 * Which environment this process runs in. Production is deliberately not
 * allowed yet: it needs launch gates G1 to G5 closed and the founder's
 * explicit approval, and then a reviewed change to this file.
 */
export const ALLOWED_ENVIRONMENTS = ['development', 'test', 'staging'] as const;
export type AppEnvironment = (typeof ALLOWED_ENVIRONMENTS)[number];

export function resolveEnvironment(value = process.env.APP_ENV ?? 'development'): AppEnvironment {
  if ((ALLOWED_ENVIRONMENTS as readonly string[]).includes(value)) return value as AppEnvironment;
  throw new Error(
    `APP_ENV "${value}" is not allowed. Only ${ALLOWED_ENVIRONMENTS.join(', ')} can run before launch gates G1 to G5 are closed and the founder approves production.`,
  );
}
