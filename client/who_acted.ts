// Who acted, in the editor's words (SPEC §11, docs/DESIGN.md): a person in the editor reads as
// the person alone, a person through another client reads with the client, and a service token
// reads as one, since a service token is automation: Claude signs in as the person it works for.

import type { SendView } from "../shared/sends";
import { type Actor, CLAUDE_CODE_CLIENT, EDITOR_CLIENT } from "../shared/who_acted";

// Clients the editor knows by a name of their own. Any other reads as it named itself.
const CLIENT_NAMES: Record<string, string> = {
  [CLAUDE_CODE_CLIENT]: "Claude Code",
};

/**
 * Who made a change, as the editor shows it: `who` is a person's email or `service`, and
 * `client` the client a person came through, null when it named none. A service token reads
 * by its name, `tokenId`, where the record keeps one. Null when nobody is recorded.
 */
export function whoActed(
  who: string | null,
  client: string | null,
  tokenId?: string | null,
): string | null {
  if (!who) {
    return null;
  }
  if (who === "service") {
    return tokenId ? `the service token ${tokenId}` : "a service token";
  }
  if (client === EDITOR_CLIENT) {
    return who;
  }
  if (client === null) {
    return `${who} via the API`;
  }
  return `${who} via ${CLIENT_NAMES[client] ?? client}`;
}

/** Who acted, as the API reports it on a record (`Actor`), in the editor's words. */
export function actorLabel(actor: Actor): string {
  if (actor.kind === "service") {
    return whoActed("service", null, actor.token_id) ?? "a service token";
  }
  return whoActed(actor.email ?? null, actor.client) ?? "a person";
}

// A send's acts in the order they happen, each with the words that lead its actor.
const SEND_ACTS = [
  ["scheduled_by", "scheduled"],
  ["rescheduled_by", "rescheduled"],
  ["canceled_by", "canceled"],
  ["resolved_by", "resolved"],
] as const;

/**
 * Who acted on a send, as one line (DESIGN §3, §4): each act recorded on it, in the order they
 * happen ("Scheduled by you@example.com via Claude Code · rescheduled by you@example.com"). Null when
 * none is recorded, as for a send made before who acted was, or none is known yet.
 */
export function sendActedBy(
  send: Partial<Pick<SendView, "scheduled_by" | "rescheduled_by" | "canceled_by" | "resolved_by">>,
): string | null {
  const parts = SEND_ACTS.flatMap(([field, verb]) => {
    const actor = send[field];
    return actor ? [`${verb} by ${actorLabel(actor)}`] : [];
  });
  const line = parts.join(" · ");
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : null;
}

/** Whether `actor` is `you` working in the editor, the one actor the editor never needs to name:
 *  the person signed in here, through the editor. */
export function isYouInEditor(actor: Actor, you: Actor | null): boolean {
  return (
    actor.kind === "human" &&
    you?.kind === "human" &&
    actor.email === you.email &&
    actor.client === EDITOR_CLIENT
  );
}

/**
 * Who last acted on a scheduled send, as its banner shows it (DESIGN §4, §10): the latest act,
 * a move when there was one and otherwise the schedule ("Rescheduled by you@example.com via Claude
 * Code"), and only when someone other than you in the editor took it (Claude Code, a script, a
 * service token, or another person). Nothing when you did, which you already know, or when none
 * is recorded. The send's page shows every act.
 */
export function bannerActedBy(
  send: Partial<Pick<SendView, "scheduled_by" | "rescheduled_by">>,
  you: Actor | null,
): string | null {
  const latest = send.rescheduled_by
    ? { verb: "Rescheduled", actor: send.rescheduled_by }
    : send.scheduled_by
      ? { verb: "Scheduled", actor: send.scheduled_by }
      : null;
  if (!latest || isYouInEditor(latest.actor, you)) {
    return null;
  }
  return `${latest.verb} by ${actorLabel(latest.actor)}`;
}
