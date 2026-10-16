// The settings surface as both clients read it: GET /api/settings (SPEC §9). Preferences
// the publisher edits, the read-only deployment reflection, and what a template or
// identity change would re-make. The Worker's route builds these shapes and the editor
// consumes them; one definition, so neither can drift.

import type { BuildInfo } from "./build";
import type { TestNotSent } from "./posts";

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
  buttonLabel: string;
  /** A quiet footer for anyone who didn't sign up; "" omits the line. */
  reassurance: string;
}

/** The publication identity as the clients consume it, with the logo as a resolved URL ("" when unset). */
export interface PublicationView {
  name: string;
  tagline: string;
  address: string;
  logoUrl: string;
}

/** The warning a settings save returns when it leaves a mailing address set that the
 *  template doesn't print (SPEC §9). Advice, never a refusal: whether a publication needs an
 *  address is the publisher's call, and a template may carry one written in by hand. Shared
 *  so the editor can recognize it and link the docs beside it, while the API's string stays
 *  plain text. */
export const ADDRESS_NOT_PRINTED =
  "You’ve added a mailing address in Settings, but this template doesn’t include the {{ .Publication.Address }} field. If you send promotional email, add it to the footer. If you’ve written your address into the template yourself, or don’t need to provide one, you can ignore this or remove the address in Settings.";

/** The identity fields an email template can carry, named as the settings surface names them. */
export type IdentityField = "name" | "tagline" | "logoUrl" | "address";

/**
 * Where the notifications that tell the publisher about their sends go (SPEC §8). An
 * address only, never a credential: the channel and its sender are deploy config.
 */
export interface NotificationPrefs {
  /** The publisher's address, or "" for no notifications. */
  to: string;
}

/** The editable preferences, resolved: a concrete template and confirmation copy, never a blank. */
export interface SettingsView {
  testRecipients: string[];
  publication: PublicationView;
  emailTemplate: string;
  confirmationEmail: ConfirmationEmailCopy;
  confirmationEmailDefault: ConfirmationEmailCopy;
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

/** The local send simulation a dev server runs, from `SIMULATE_SENDS`; only ever set in local dev. */
export interface SimulationView {
  profile: SimulationProfile;
  faults: SimulationFaults;
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
  fromAddress: string;
  sendingDomain: string;
  appOrigin: string;
  archiveOrigin: string;
  archiveBasePath: string;
  mediaPublicBase: string;
  awsRegion: string;
  accessConfigured: boolean;
  /** How the reader of this reflection signed in: through Access, or with the local dev token. */
  authMode: "access" | "dev";
  build: BuildInfo;
  /** How notifications reach the publisher: Cloudflare's own email, the newsletter's provider, or the dev fake that delivers nothing. */
  notifyChannel: "cloudflare" | "provider" | "fake";
  /** The `From:` a notification carries. */
  notifyFrom: string;
  /** The minimum lead (SPEC §6): every schedule, send now, and reschedule fires at least this long after the request. Never under `MIN_LEAD_FLOOR_MS` or over `MIN_LEAD_CEILING_MS`. */
  minLeadMs: number;
  /** The local send simulation standing in for a provider, or null: always null once deployed. */
  simulation: SimulationView | null;
  /** True when `provider` is `none` because local dev previews the not-connected state (`SIMULATE_SENDS=not-connected`), whose way out is a restart, not a deploy: always false once deployed. */
  notConnectedPreview: boolean;
  /** True on the Workers Free plan's limits (`SUBREQUEST_BUDGET` unset): the import limit, the export's page, and the advice to move to Workers Paid follow it. */
  freePlanLimits: boolean;
}

/** What a notification about a send is about (SPEC §8): it finished, or one of the conditions that need the publisher. */
export type SendNotificationKind = "finished" | "refused" | "stuck" | "wedged" | "missed";

/** What a notification is about (SPEC §8): a send, a list Claude imported for the publisher,
 *  or a signup's confirmation the SES sandbox refused (`sandbox`, at most one a UTC day). */
export type NotificationKind = SendNotificationKind | "import" | "sandbox";

/** What a line of the notification status is about: an event, or a test from the settings surface (whose subject is ""). An import's subject is its file's name. */
export type NotificationStatusKind = NotificationKind | "test";

/** How notifications have gone lately, so a channel that stopped working is visible where the destination is set. */
export interface NotificationStatusView {
  /** The last notification delivered (a test counts), or null if none has been. */
  lastSent: { kind: NotificationStatusKind; subject: string; at: number } | null;
  /** The last failed try, when newer than the last delivered one; null otherwise. */
  lastFailure: {
    kind: NotificationStatusKind;
    subject: string;
    at: number;
    error: string;
  } | null;
}

/** A scheduled send a template or identity change would re-make (SPEC §6, §9). */
export interface ScheduledSendRef {
  id: string;
  post_id: string;
  subject: string;
  fire_at: number;
  remade_at: number | null;
}

/** What a save of the template or identity would touch, read before saving. */
export interface InUseView {
  sends: ScheduledSendRef[];
  /** When a save stops being refused for the lead (ms since epoch), or null when it isn't. */
  retry_after: number | null;
  identityFields: IdentityField[];
}

export interface SettingsResponse {
  settings: SettingsView;
  deployment: DeploymentView;
  inUse: InUseView;
  notificationStatus: NotificationStatusView;
}

/**
 * PUT /api/settings: any subset of the editable preferences, plus `remake`, the ids of the
 * scheduled sends the client acknowledges the save will re-make (SPEC §9).
 */
export interface SettingsPatchBody {
  testRecipients?: string[];
  publication?: Partial<Pick<PublicationView, "name" | "tagline" | "address">>;
  emailTemplate?: string;
  confirmationEmail?: Partial<ConfirmationEmailCopy>;
  notifications?: Partial<NotificationPrefs>;
  remake?: string[];
}

/** PUT /api/settings: the settings as stored, the template's advisory warnings, and the scheduled sends the save re-made. */
export interface SettingsSavedResponse {
  settings: SettingsView;
  warnings: string[];
  remade: ScheduledSendRef[];
}

/** POST and DELETE /api/settings/logo: the settings as stored and the scheduled sends the change re-made. */
export interface LogoResponse {
  settings: SettingsView;
  remade: ScheduledSendRef[];
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

/** POST /api/settings/notifications/test: a sample notification to the saved address, through the live channel. */
export interface NotificationTestResponse {
  to: string;
  channel: DeploymentView["notifyChannel"];
}

/** The 409 a template or identity save gets until the client acknowledges the sends it re-makes (SPEC §9). */
export interface RemakeRequiredError {
  error: "remake_required";
  message: string;
  sends: ScheduledSendRef[];
}

/** The 409 a template or identity save gets while a scheduled send is about to fire (SPEC §9). */
export interface RemakeTooCloseError {
  error: "remake_too_close";
  message: string;
  /** When a save stops being refused (ms since epoch). */
  retry_after: number;
  sends: ScheduledSendRef[];
}
