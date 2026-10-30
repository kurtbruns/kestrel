// The settings surface as both clients read it: GET /api/settings (SPEC §9). Preferences
// the publisher edits, the read-only deployment reflection, and what a template or
// identity change would re-make. The Worker's route builds these shapes and the editor
// consumes them; one definition, so neither can drift.

import type { BuildInfo } from "./build";
import type { TestNotSent } from "./posts";
import type { RefusingCause } from "./provider";
import type { SendView } from "./sends";

/** One address a template test missed, and why. */
export interface TemplateTestMiss extends TestNotSent {
  email: string;
}

/** The double opt-in confirmation email's editable copy (SPEC §7). */
export interface ConfirmationEmailCopy {
  /** The email subject. */
  subject: string;
  /** The message shown above the confirm button. */
  body: string;
  /** The confirm button's label (the link itself is app-generated, never authored). */
  button_label: string;
  /** A quiet footer for anyone who didn't sign up; "" omits the line. */
  reassurance: string;
}

/** The publication identity as the clients consume it, with the logo as a resolved URL ("" when unset). */
export interface PublicationView {
  name: string;
  tagline: string;
  address: string;
  logo_url: string;
}

/** The warning a settings save returns when it leaves a mailing address set that the
 *  template doesn't print (SPEC §9). Advice, never a refusal: whether a publication needs an
 *  address is the publisher's call, and a template may carry one written in by hand. Shared
 *  so the editor can recognize it and link the docs beside it, while the API's string stays
 *  plain text. */
export const ADDRESS_NOT_PRINTED =
  "You’ve added a mailing address in Settings, but this template doesn’t include the {{ .Publication.Address }} field. If you send promotional email, add it to the footer. If you’ve written your address into the template yourself, or don’t need to provide one, you can ignore this or remove the address in Settings.";

/** The identity fields an email template can carry, named as the settings surface names them. */
export type IdentityField = "name" | "tagline" | "logo_url" | "address";

/** The most addresses notifications go to (SPEC §8): enough for the publisher and whoever
 *  runs the instance, and few enough that each notification stays a handful of requests. */
export const MAX_NOTIFY_ADDRESSES = 5;

/**
 * Where the notifications that tell the publisher about their sends go (SPEC §8).
 * Addresses only, never a credential: the channel and its sender are deploy config.
 */
export interface NotificationPrefs {
  /** Every address a notification goes to, in the order saved; empty for no notifications. */
  to: string[];
}

/** The editable preferences, resolved: a concrete template and confirmation copy, never a blank. */
export interface SettingsView {
  test_recipients: string[];
  publication: PublicationView;
  email_template: string;
  confirmation_email: ConfirmationEmailCopy;
  confirmation_email_default: ConfirmationEmailCopy;
  notifications: NotificationPrefs;
}

/**
 * The providers the local send simulation can model (SPEC §10): `ses` takes its traits from
 * the real adapter, and `generic` is a small-batch provider paced to be watched.
 */
export const SIMULATION_PROFILES = ["generic", "ses"] as const;
export type SimulationProfile = (typeof SIMULATION_PROFILES)[number];

/** Which of a provider's failures the simulation injects: a real provider's mix, or none for a clean demo. */
export const SIMULATION_FAULTS = ["realistic", "none"] as const;
export type SimulationFaults = (typeof SIMULATION_FAULTS)[number];

/** The SES account states a local server can stand in for, from `SIMULATE_ACCOUNT`. */
export const SIMULATED_ACCOUNTS = [
  "sandbox",
  "pending",
  "denied",
  "production",
  "permission",
] as const;
export type SimulatedAccount = (typeof SIMULATED_ACCOUNTS)[number];

/**
 * The refusals of the account a local server's simulated SES can answer every email with
 * (`SIMULATE_SENDS=ses:refuse=<cause>`), each one an SES error response the real adapter
 * reads as that cause (SPEC §9, §10). Every refusing cause but a missing sending pool, which
 * SES reports only in a bulk entry's result, not as an error.
 */
export const SIMULATED_REFUSALS = [
  "credentials",
  "opt_in",
  "configuration",
  "sender",
  "mail_from",
  "paused",
  "set_paused",
  "suspended",
  "unsupported",
] as const satisfies readonly RefusingCause[];

/** The account problems a local server can stand in for, each one the account check finds (SPEC §9). */
export const SIMULATED_ACCOUNT_PROBLEMS = [
  "set_missing",
  "set_paused",
  "key_rejected",
  "sending_disabled",
  "shutdown",
  "sender_unverified",
  "probation",
] as const;
export type SimulatedAccountProblem = (typeof SIMULATED_ACCOUNT_PROBLEMS)[number];

/** The SES account a local server stands in for: its state, whether bounces reach the app, and any problem it has. */
export interface SimulatedAccountView {
  state: SimulatedAccount;
  bounces_routed: boolean;
  problem: SimulatedAccountProblem | null;
}

/** The local send simulation a dev server runs, from `SIMULATE_SENDS`; only ever set in local dev. */
export interface SimulationView {
  profile: SimulationProfile;
  faults: SimulationFaults;
  /** The refusal of the account it answers every email with, from `SIMULATE_SENDS=ses:refuse=<cause>`; null for none. */
  refuse: RefusingCause | null;
  /** The SES account it stands in for, from `SIMULATE_ACCOUNT`; null leaves the account unread. */
  account: SimulatedAccountView | null;
}

/**
 * The email provider a deployment sends through (SPEC §9): `none` while none is connected,
 * when every send is refused; `fake`, named for local development, the tests, or a demo,
 * which records a send and delivers nothing; or a real provider.
 */
export type DeploymentProvider = "none" | "fake" | "ses";

/** The deploy-time configuration, reflected read-only: origins, provider, and whether Access gates the surface. Never a secret. */
export interface DeploymentView {
  provider: DeploymentProvider;
  from_address: string;
  sending_domain: string;
  app_origin: string;
  archive_origin: string;
  archive_base_path: string;
  media_public_base: string;
  aws_region: string;
  access_configured: boolean;
  /** How the reader of this reflection signed in: through Access, or with the local dev token. */
  auth_mode: "access" | "dev";
  build: BuildInfo;
  /** How notifications reach the publisher: Cloudflare's own email, the newsletter's provider, or the dev fake that delivers nothing. */
  notify_channel: "cloudflare" | "provider" | "fake";
  /** The `From:` a notification carries. */
  notify_from: string;
  /** The minimum lead (SPEC §6): every schedule, send now, and reschedule fires at least this long after the request. Never under `MIN_LEAD_FLOOR_MS` or over `MIN_LEAD_CEILING_MS`. */
  min_lead_ms: number;
  /** The local send simulation standing in for a provider, or null: always null once deployed. */
  simulation: SimulationView | null;
  /** True when `provider` is `none` because local dev previews the not-connected state (`SIMULATE_SENDS=not-connected`), whose way out is a restart, not a deploy: always false once deployed. */
  not_connected_preview: boolean;
  /** True on the Workers Free plan's limits (`SUBREQUEST_BUDGET` unset): the import limit, the export's page, and the advice to move to Workers Paid follow it. */
  free_plan_limits: boolean;
}

/** What a notification about a send is about (SPEC §8): it finished, or one of the conditions that need the publisher. */
export type SendNotificationKind = "finished" | "refused" | "stuck" | "wedged" | "missed";

/** What a notification is about (SPEC §8): a send, a list Claude imported for the publisher,
 *  a signup's confirmation the SES sandbox refused (`sandbox`, at most one a UTC day), or email
 *  not going out with no send behind it (`not_sending`, at most one a UTC day). */
export type NotificationKind = SendNotificationKind | "import" | "sandbox" | "not_sending";

/** What a line of the notification status is about: an event, or a test from the settings surface (whose subject is ""). An import's subject is its file's name. */
export type NotificationStatusKind = NotificationKind | "test";

/** How notifications have gone lately, so a channel that stopped working is visible where the destination is set. */
export interface NotificationStatusView {
  /** The last notification delivered (a test counts), or null if none has been. */
  last_sent: { kind: NotificationStatusKind; subject: string; at: number } | null;
  /** The last failed try, when newer than the last delivered one; null otherwise. */
  last_failure: {
    kind: NotificationStatusKind;
    subject: string;
    at: number;
    error: string;
  } | null;
}

/** What a save of the template or identity would touch, read before saving. */
export interface InUseView {
  /** Every scheduled send, soonest first, each as its own view: what the save would re-make (SPEC §9). */
  sends: SendView[];
  /** When a save stops being refused for the lead (ms since epoch), or null when it isn't. */
  retry_after: number | null;
  identity_fields: IdentityField[];
}

export interface SettingsResponse {
  settings: SettingsView;
  deployment: DeploymentView;
  in_use: InUseView;
  notification_status: NotificationStatusView;
}

/**
 * PUT /api/settings: any subset of the editable preferences, plus `remake`, the ids of the
 * scheduled sends the client acknowledges the save will re-make (SPEC §9).
 */
export interface SettingsPatchBody {
  test_recipients?: string[];
  publication?: Partial<Pick<PublicationView, "name" | "tagline" | "address">>;
  email_template?: string;
  confirmation_email?: Partial<ConfirmationEmailCopy>;
  notifications?: Partial<NotificationPrefs>;
  remake?: string[];
}

/** PUT /api/settings: the settings as stored, the template's advisory warnings, and the scheduled sends the save re-made. */
export interface SettingsSavedResponse {
  settings: SettingsView;
  warnings: string[];
  remade: SendView[];
}

/** POST and DELETE /api/settings/logo: the settings as stored and the scheduled sends the change re-made. */
export interface LogoResponse {
  settings: SettingsView;
  remade: SendView[];
}

/** POST /api/settings/template/test: a sample post through the saved template, to each recipient. */
export interface TemplateTestResponse {
  sent: number;
  total: number;
  /** The recipients the provider didn't accept, in the order asked; empty when all were sent. */
  failed: string[];
  /** Why each address in `failed` wasn't sent, in the same order. */
  not_sent: TemplateTestMiss[];
  provider: string;
  recipients: string[];
  subject: string;
  warnings: string[];
}

/** One saved address a notification or a test didn't reach, with the channel's words. */
export interface NotificationTestMiss {
  email: string;
  error: string;
}

/**
 * The channel's words for the addresses a notification or a test missed, as the settings
 * surface shows them: the words alone when notifications go to one address, and each led by
 * its address when they go to several, so the publisher can tell which to fix. One
 * definition, so the status line the editor paints after a test reads as the one the server
 * records.
 */
export function missedAddresses(
  to: readonly string[],
  missed: readonly NotificationTestMiss[],
): string {
  if (to.length === 1 && missed.length === 1) {
    return missed[0]?.error ?? "";
  }
  return missed.map((m) => `${m.email}: ${m.error}`).join("; ");
}

/** POST /api/settings/notifications/test: a sample notification to every saved address, through the live channel. */
export interface NotificationTestResponse {
  /** Every saved address it was sent to, in the order saved. */
  to: string[];
  /** The addresses the channel refused, each with its words; empty when every one got it. */
  failed: NotificationTestMiss[];
  channel: DeploymentView["notify_channel"];
}

/** The 409 a template or identity save gets until the client acknowledges the sends it re-makes (SPEC §9). */
export interface RemakeRequiredError {
  error: "remake_required";
  message: string;
  sends: SendView[];
}

/** The 409 a template or identity save gets while a scheduled send is about to fire (SPEC §9). */
export interface RemakeTooCloseError {
  error: "remake_too_close";
  message: string;
  /** When a save stops being refused (ms since epoch). */
  retry_after: number;
  sends: SendView[];
}
