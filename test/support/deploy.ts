/**
 * Deploy config `getConfig` accepts off the fake transport. It refuses a real provider
 * without its credentials, and any provider but the fake while a setting is still on the
 * template's example.com placeholder, as the development config the suite runs under is, so
 * a test that switches `PROVIDER` spreads one of these over the env. The origin stays the
 * suite's own (loopback is allowed).
 */

/** The topic the SES webhook accepts; a signed message from any other is refused. */
export const SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:kestrel-ses";

const SENDER = {
  SENDING_DOMAIN: "send.birds.example",
  FROM_ADDRESS: "Birds <news@send.birds.example>",
};

/** No provider connected (SPEC §9), as the production template ships, its sender filled in. */
export const NOT_CONNECTED_DEPLOY = { ...SENDER, PROVIDER: "" } as const;

export const SES_DEPLOY = {
  ...SENDER,
  PROVIDER: "ses",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "AKIATESTTESTTEST",
  AWS_SECRET_ACCESS_KEY: "test-secret-key-abc123",
  SNS_TOPIC_ARN,
} as const;

export const RESEND_DEPLOY = {
  ...SENDER,
  PROVIDER: "resend",
  RESEND_API_KEY: "re_test_key",
  RESEND_WEBHOOK_SECRET: `whsec_${btoa("test-svix-signing-key-0123456789")}`,
} as const;
