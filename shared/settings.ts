// The settings surface as both clients read it: GET /api/settings (SPEC §9). Preferences
// the publisher edits, the read-only deployment reflection, and what a template or
// identity change would re-make. The Worker's route builds these shapes and the editor
// consumes them; one definition, so neither can drift.

import type { BuildInfo } from "./build";

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

/** The deploy-time configuration, reflected read-only: origins, provider, and whether Access gates the surface. Never a secret. */
export interface DeploymentView {
  provider: string;
  fromAddress: string;
  sendingDomain: string;
  appOrigin: string;
  archiveOrigin: string;
  archiveBasePath: string;
  mediaPublicBase: string;
  awsRegion: string;
  accessConfigured: boolean;
  authMode: "access" | "dev";
  build: BuildInfo;
  /** How notifications reach the publisher: Cloudflare's own email, the newsletter's provider, or the dev fake that delivers nothing. */
  notifyChannel: "cloudflare" | "provider" | "fake";
  /** The `From:` a notification carries. */
  notifyFrom: string;
}

/** What a notification is about (SPEC §8): a send finished, or one of the conditions that need the publisher. */
export type NotificationKind = "finished" | "refused" | "stuck" | "wedged" | "missed";

/** How notifications have gone lately, so a channel that stopped working is visible where the destination is set. */
export interface NotificationStatusView {
  /** The last notification delivered, or null if none has been. */
  lastSent: { kind: NotificationKind; subject: string; at: number } | null;
  /** The last failed try, when newer than the last delivered one; null otherwise. */
  lastFailure: { kind: NotificationKind; subject: string; at: number; error: string } | null;
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
