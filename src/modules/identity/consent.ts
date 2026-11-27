/**
 * Consent wording shown to the customer. Changing the words means a new
 * version, and the version the customer saw is stored with their consent.
 */
export const SHARE_WITH_INSURER_CONSENT = {
  version: 'share-with-insurer-v1',
  text: 'I agree that AfyaPay may share my phone number and policy number with {insurer} so that {insurer} can confirm this policy is mine and match my payments to it.',
} as const;

export const SMS_REMINDERS_CONSENT = {
  version: 'sms-reminders-v1',
  text: 'Send me SMS reminders when a premium is coming due or is behind. I can turn this off at any time. Payment receipts are always sent.',
} as const;

export const PLAN_INTEREST_CONSENT = {
  version: 'plan-interest-v1',
  text: 'I agree that AfyaPay may share my phone number, household size and county with {insurer} so that {insurer} can contact me about {plan}. This is not a purchase and I do not have cover from it.',
} as const;
