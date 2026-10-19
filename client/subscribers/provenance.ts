// How a subscriber joined, in the roster's words (SPEC §7): keyed on the import that
// brought them, never on what a file claimed, so only a confirmation Kestrel recorded
// itself reads as its double opt-in.

import type { OptIn } from "../../shared/imports";
import type { Subscriber } from "../../shared/subscribers";

// Services a list is commonly brought from, as their own names spell them. Any other origin
// reads with its first letter raised.
const ORIGIN_NAMES: Record<string, string> = {
  buttondown: "Buttondown",
  convertkit: "ConvertKit",
  kit: "Kit",
  kestrel: "Kestrel",
  mailchimp: "Mailchimp",
  mailerlite: "MailerLite",
  sendy: "Sendy",
  substack: "Substack",
  beehiiv: "beehiiv",
  ghost: "Ghost",
};

/** An import's origin as a name: `sendy` reads Sendy; `unknown`, or none kept, reads as none. */
export function originName(origin: string | null): string | null {
  if (origin === null || origin === "" || origin === "unknown") {
    return null;
  }
  return ORIGIN_NAMES[origin] ?? origin.charAt(0).toUpperCase() + origin.slice(1);
}

/** How consent was collected, as a phrase. */
export function optInPhrase(optIn: OptIn | null): string {
  return optIn === null || optIn === "unknown" ? "opt-in unknown" : `${optIn} opt-in`;
}

/**
 * The "How they joined" cell: "Imported · Sendy, single opt-in" for anyone an import
 * brought, "Double opt-in" for a confirmation recorded here, and null (nothing to say yet)
 * for someone who signed up here and hasn't confirmed.
 */
export function joinedVia(
  s: Pick<Subscriber, "import_id" | "origin" | "opt_in" | "confirmed_at">,
): string | null {
  if (s.import_id !== null) {
    return `Imported · ${[originName(s.origin), optInPhrase(s.opt_in)].filter(Boolean).join(", ")}`;
  }
  return s.confirmed_at !== null ? "Double opt-in" : null;
}

/** The consent evidence, pretty-printed (as it is, if it isn't JSON), or null when none was recorded. */
export function evidenceText(evidence: string | null): string | null {
  if (!evidence) {
    return null;
  }
  try {
    return JSON.stringify(JSON.parse(evidence), null, 2);
  } catch {
    return evidence;
  }
}
