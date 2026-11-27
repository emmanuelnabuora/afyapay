// Test-only values. Not secrets.
process.env.APP_ENV = 'test';
process.env.AUTH_SECRET = 'test-only-auth-secret-not-real-000000000';
process.env.MPESA_CALLBACK_SECRET = 'test-only-callback-secret-0000';
process.env.MFA_SECRET_KEY = 'test-only-mfa-secret-key-not-real-0000';
process.env.PII_ENCRYPTION_KEY = 'test-only-pii-encryption-key-not-real-00';
