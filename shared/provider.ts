// The email provider's connection as both clients read it: GET /api/provider (SPEC §9). One
// of a few states the editor branches on, the facts the provider's account gave about itself,
// and any warning in the server's own words. The Worker's route builds this shape and the
// editor consumes it; one definition, so neither can drift.

import type { DeploymentProvider } from "./settings";

/**
 * Where the connection stands. `not_connected`: no provider named (SPEC §9). `sandbox`: SES
 * mails only addresses verified with it. `production`: anyone can be mailed. `unknown`: the
 * app couldn't learn which (`unknown_reason` says why), which is never an error.
 */
export type ProviderState = "not_connected" | "sandbox" | "production" | "unknown";

/**
 * Why the state is `unknown`. `permission`: the provider's key isn't allowed to ask about its
 * account. `rejected`: the provider rejects the key itself. `unreachable`: asking got no usable answer, and there is no earlier one. `not_checked`:
 * the app hasn't asked yet. `stand_in`: local development's stand-in, which has no account.
 */
export type ProviderUnknownReason =
  | "permission"
  | "rejected"
  | "unreachable"
  | "not_checked"
  | "stand_in";

/**
 * AWS's review of the latest request for production access, in its own terms. `denied` is
 * AWS's word for a request it has replied to without a grant, whether it asks for more or
 * refuses, so the editor and Claude read it as "answer in the case", never as a refusal.
 */
export type ProductionReview = "pending" | "granted" | "denied" | "failed";

/** Where the send rate a send keeps to comes from: the account, `SES_MAX_SEND_RATE`, or Kestrel's default. */
export type SendRateSource = "account" | "setting" | "default";

/** AWS's view of the account's sending practices: fine, under review, or paused. */
export type AccountEnforcement = "healthy" | "probation" | "shutdown";

/** What the account said about its own limits and standing, as of `checked_at`. */
export interface ProviderAccountView {
  /** Messages a second the account may send. */
  max_send_rate: number;
  /** Messages in any 24 hours; null when unlimited. */
  max_24_hour_send: number | null;
  sent_last_24_hours: number;
  enforcement: AccountEnforcement | null;
  sending_enabled: boolean;
}

/** Which configuration set SES files the mail's bounces and complaints under, and how it was found. */
export interface ConfigurationSetView {
  /** The set's name; null when none applies. */
  name: string | null;
  /** `setting`: `SES_CONFIGURATION_SET`. `identity`: the sending identity's default. `none`: neither. */
  source: "setting" | "identity" | "none";
}

/**
 * What a provider warning is about. Errors stop every email: `configuration_set_missing` and
 * `configuration_set_paused` (the set that applies), `key_rejected`, `sending_disabled` (the
 * account's sending, turned off or paused by AWS), `sender_unverified`. Warnings leave sending
 * working: `account_probation` (AWS reviewing the account's practices), `bounces_not_routed`
 * (no configuration set applies, so bounces and complaints never reach the app).
 */
export type ProviderWarningCode =
  | "configuration_set_missing"
  | "configuration_set_paused"
  | "key_rejected"
  | "sending_disabled"
  | "sender_unverified"
  | "account_probation"
  | "bounces_not_routed";

/** Something about the connection worth the publisher's look, in words the editor shows as they come. */
export interface ProviderWarning {
  code: ProviderWarningCode;
  /** `error`: no email can go out until it's fixed. `warn`: sending still works. */
  severity: "error" | "warn";
  message: string;
  /** The docs page and heading that fix it. */
  docs: { slug: string; anchor: string };
}

/** GET /api/provider. */
export interface ProviderStatusView {
  provider: DeploymentProvider;
  state: ProviderState;
  unknown_reason: ProviderUnknownReason | null;
  review: ProductionReview | null;
  /** AWS Support's case for the review, when it has one. */
  review_case: string | null;
  /** The rate a send keeps to, in messages a second, and where it comes from; null without SES. */
  send_rate: { value: number; source: SendRateSource } | null;
  account: ProviderAccountView | null;
  configuration_set: ConfigurationSetView | null;
  warnings: ProviderWarning[];
  /** When the account last answered; null when it never has. */
  checked_at: number | null;
}
