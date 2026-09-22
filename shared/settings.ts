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

/** The editable preferences, resolved: a concrete template and confirmation copy, never a blank. */
export interface SettingsView {
  testRecipients: string[];
  publication: PublicationView;
  emailTemplate: string;
  confirmationEmail: ConfirmationEmailCopy;
  confirmationEmailDefault: ConfirmationEmailCopy;
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
}

/** The 409 a template or identity save gets until the client acknowledges the sends it re-makes (SPEC §9). */
export interface RemakeRequiredError {
  error: "remake_required";
  message: string;
  sends: ScheduledSendRef[];
}
