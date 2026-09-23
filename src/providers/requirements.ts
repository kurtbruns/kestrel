/**
 * What each transport needs from deploy config (SPEC §9): the names `PROVIDER` may hold,
 * and the vars and secrets a real transport cannot run without. `getConfig` validates
 * against these, so a provider declares its needs beside its adapter and a deployment
 * missing one fails at the first request instead of at its first send.
 */
import type { AppEnv } from "../env";

export const PROVIDER_NAMES = ["fake", "ses", "resend"] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** A transport that reaches real inboxes, as opposed to the in-memory `fake`. */
export type RealProviderName = Exclude<ProviderName, "fake">;

/**
 * Required per real transport. SES needs `SNS_TOPIC_ARN` because its webhook refuses every
 * message without it: the topic is what proves a signed notification is this deployment's.
 */
export const REQUIRED_VARS: Record<RealProviderName, readonly (keyof AppEnv)[]> = {
  ses: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "SNS_TOPIC_ARN"],
  resend: ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"],
};

export function isProviderName(v: string): v is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(v);
}
